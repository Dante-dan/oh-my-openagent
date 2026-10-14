//! Quartz capture: TCC preflight, display/window enumeration, and
//! `screencapture`-based capture with a display-only CoreGraphics fallback.
//! Never prompts for permission. Known cursor-helper windows are excluded by ScreenCaptureKit.

mod displays;
pub(crate) mod fallback;
pub(crate) mod screencapture;
mod windows;
mod filtered;

use image::RgbaImage;
use senpi_desktop_core::error::{CoreResult, DesktopError, TccPermission};
use senpi_desktop_core::frame::FrameGeometry;
use senpi_desktop_core::types::{DesktopDisplay, DesktopWindow, DisplaySelector, Target};

pub(crate) use self::screencapture::Screencapture;
use self::screencapture::{display_args, window_args, ShotError};

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    /// Non-prompting TCC preflight for Screen Recording; takes no arguments.
    safe fn CGPreflightScreenCaptureAccess() -> bool;
}

/// Whether captures can hide cursor-helper windows per frame (macOS 14+).
pub(crate) fn filtered_capture_supported() -> bool {
    filtered::supported()
}

/// Whether this process may capture the screen, without prompting.
pub(crate) fn capture_permission() -> bool {
    CGPreflightScreenCaptureAccess()
}

/// Screen Recording guidance for the launcher whose TCC grant is missing.
pub(crate) fn permission_denied() -> DesktopError {
    crate::backend::permissions::permission_denied(TccPermission::ScreenRecording)
}

#[derive(Debug, Clone)]
pub(crate) struct MacCapture {
    selector: DisplaySelector,
    shooter: Screencapture,
    overlay: crate::overlay::Overlay,
}

impl MacCapture {
    pub(crate) fn new(selector: DisplaySelector, shooter: Screencapture) -> Self {
        Self { selector, shooter, overlay: crate::overlay::Overlay::default() }
    }

    pub(crate) fn with_overlay(mut self, overlay: crate::overlay::Overlay) -> Self {
        self.overlay = overlay;
        self
    }

    pub(crate) fn permission_granted(&self) -> bool {
        self.shooter.permission_granted()
    }

    /// The displays the session's selector names (all, for active).
    pub(crate) fn displays(&self) -> CoreResult<Vec<DesktopDisplay>> {
        self.require_permission()?;
        displays::enumerate(&self.selector)
    }

    /// Every monitor, whatever the session's selector, so a per-call display
    /// target can name one the session does not capture by default.
    pub(crate) fn all_displays(&self) -> CoreResult<Vec<DesktopDisplay>> {
        self.require_permission()?;
        displays::enumerate(&DisplaySelector::All)
    }

    pub(crate) fn windows(&self) -> CoreResult<Vec<DesktopWindow>> {
        self.require_permission()?;
        windows::enumerate()
    }

    pub(crate) fn capture(&self, target: &Target) -> CoreResult<(RgbaImage, FrameGeometry)> {
        self.require_permission()?;
        // The guard surrounds the entire dispatch, not just screencapture.
        // It therefore also covers multi-display batches and CoreGraphics.
        let lock_path = crate::overlay::lock_path().map_err(|error| {
            DesktopError::capture_failed(format!("cannot locate account cursor-exclusion cache: {error}"))
        })?;
        self.overlay.capture(&lock_path, crate::focus::window_info, std::thread::sleep, |excluded| {
            let result = match target {
                Target::Desktop | Target::Display(_) => {
                    let selector = target.display_selector().unwrap_or_else(|| self.selector.clone());
                    self.capture_desktop(&selector, excluded)
                }
                Target::Window(id) => self.capture_window(id, excluded),
            }?;
            // A launcher with another cache domain must not introduce an unfiltered helper.
            let after = crate::focus::window_info()?;
            if after.iter().any(|window| window.cursor_overlay && !excluded.contains(&window.window_number)) {
                return Err(DesktopError::capture_failed("a new cursor helper was not included in the exclusion filter"));
            }
            Ok(result)
        })
    }

    fn require_permission(&self) -> CoreResult<()> {
        if self.permission_granted() {
            Ok(())
        } else {
            Err(permission_denied())
        }
    }

    /// One `screencapture -x -R<rect>` per display, composited. When the tool
    /// is absent or fails with permission granted, the primary display is
    /// captured through CoreGraphics instead.
    fn capture_desktop(&self, selector: &DisplaySelector, excluded: &[u32]) -> CoreResult<(RgbaImage, FrameGeometry)> {
        self.require_permission()?;
        let focused = if *selector == DisplaySelector::Active {
            match crate::focus::front_window_id() {
                Ok(Some(id)) => match windows::find(&id.to_string()) {
                    Ok(window) => Some(window),
                    Err(error) => {
                        eprintln!("active capture cannot locate the front window; using primary: {error}");
                        None
                    }
                },
                Ok(None) => None,
                Err(error) => {
                    eprintln!("active capture cannot query focus; using primary: {error}");
                    None
                }
            }
        } else {
            None
        };
        let displays = selector.select(displays::enumerate(selector)?, focused.as_ref())?;
        let mut regions = Vec::with_capacity(displays.len());
        for display in &displays {
            let image = if !excluded.is_empty() {
                let id = display.id.parse::<u32>()
                    .map_err(|_| DesktopError::capture_failed("filtered display has no native ID"))?;
                filtered::capture(Some(id), None, display.pixel_width, display.pixel_height, excluded)?
            } else {
                match self.shooter.run(&display_args(display)) {
                    Ok(image) => image,
                    Err(ShotError::Unavailable(reason)) => {
                        return fallback::capture_primary(&displays, &reason);
                    }
                    Err(ShotError::Fatal(error)) => return Err(error),
                }
            };
            if image.width() == 0 || image.height() == 0 {
                return Err(DesktopError::capture_failed(format!(
                    "capture of display '{}' returned an empty image",
                    display.id
                )));
            }
            regions.push((display.clone(), image));
        }
        displays::composite(regions)
    }

    /// `screencapture -x -o -l <wid>`; window capture has no fallback.
    fn capture_window(&self, id: &str, excluded: &[u32]) -> CoreResult<(RgbaImage, FrameGeometry)> {
        let window_id = id
            .parse::<u32>()
            .map_err(|_| DesktopError::invalid_target(format!("invalid macOS window id '{id}'")))?;
        self.require_permission()?;
        if excluded.contains(&window_id) {
            return Err(DesktopError::capture_failed("cursor-helper windows are not capture targets"));
        }
        let window = windows::find(id)?;
        let image = if !excluded.is_empty() {
            filtered::capture(None, Some(window_id), window.width, window.height, excluded)?
        } else {
            self.shooter.run(&window_args(window_id)).map_err(DesktopError::from)?
        };
        if image.width() == 0 || image.height() == 0 {
            return Err(DesktopError::capture_failed(format!(
                "capture of window '{id}' returned an empty image"
            )));
        }
        let geometry = FrameGeometry::for_window(&window, image.width(), image.height());
        Ok((image, geometry))
    }
}

/// Hides helper windows from the window list. `helper_ids` are the windows WindowServer
/// reports as helpers (title and level); without that list every title match is hidden.
fn exclude_overlay_windows(windows: &mut Vec<DesktopWindow>, helper_ids: Option<&[u32]>) {
    windows.retain(|window| {
        if window.title != crate::overlay::WINDOW_TITLE {
            return true;
        }
        helper_ids.is_some_and(|ids| window.id.parse::<u32>().map_or(true, |id| !ids.contains(&id)))
    });
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod live_tests;
