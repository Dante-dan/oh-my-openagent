//! Actionable TCC refusals. Probes never call this module; denied actions do.

use std::ffi::CStr;
use std::sync::OnceLock;

use objc2_app_kit::NSRunningApplication;

use senpi_desktop_core::error::{DesktopError, PermissionDeniedData, TccPermission};

const LAUNCHER: &str = "the app that launched OmO (for a terminal launch, that terminal app)";

fn settings_url(permission: TccPermission) -> &'static str {
    match permission {
        TccPermission::ScreenRecording => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        }
        TccPermission::Accessibility => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
    }
}

fn host_app_name() -> String {
    launcher_name(std::env::var("SENPI_DESKTOP_HOST_APP").ok())
}

fn launcher_name(value: Option<String>) -> String {
    value
        .filter(|app| !app.trim().is_empty())
        .unwrap_or_else(|| LAUNCHER.to_owned())
}

#[derive(Default)]
struct ResponsibleIdentity {
    pid: Option<libc::pid_t>,
    executable: Option<String>,
    bundle_id: Option<String>,
}

#[link(name = "proc")]
unsafe extern "C" {
    fn proc_pidpath(pid: libc::pid_t, buffer: *mut libc::c_void, buffer_size: u32) -> i32;
}

fn responsible_identity() -> ResponsibleIdentity {
    // This optional libSystem SPI is also used by Chromium. Resolve it at runtime:
    // an OS without the symbol must not fall back to guessing the parent or self.
    // SAFETY: RTLD_DEFAULT is the process symbol scope, and the name is NUL-terminated.
    let symbol = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            b"responsibility_get_pid_responsible_for_pid\0"
                .as_ptr()
                .cast(),
        )
    };
    if symbol.is_null() {
        return ResponsibleIdentity::default();
    }
    // SAFETY: the resolved macOS symbol has the pid_t -> pid_t C signature.
    let responsible: unsafe extern "C" fn(libc::pid_t) -> libc::pid_t =
        unsafe { std::mem::transmute(symbol) };
    // SAFETY: getpid yields this live process; the SPI only queries responsibility.
    let pid = unsafe { responsible(libc::getpid()) };
    if pid <= 0 {
        return ResponsibleIdentity::default();
    }
    // PROC_PIDPATHINFO_MAXSIZE
    let mut buffer = [0_u8; 4096];
    // SAFETY: proc_pidpath receives a writable buffer of its declared capacity.
    let length = unsafe { proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    let executable = if length > 0 {
        CStr::from_bytes_until_nul(&buffer)
            .ok()
            .and_then(|path| path.to_str().ok())
            .filter(|path| !path.is_empty())
            .map(str::to_owned)
    } else {
        None
    };
    let bundle_id = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
        .and_then(|app| app.bundleIdentifier())
        .map(|identifier| identifier.to_string())
        .filter(|identifier| !identifier.is_empty());
    ResponsibleIdentity {
        pid: Some(pid),
        executable,
        bundle_id,
    }
}

impl ResponsibleIdentity {
    fn diagnostic(&self) -> String {
        let pid = self
            .pid
            .map_or_else(|| "unknown".to_owned(), |pid| pid.to_string());
        format!(
            "TCC identity: executable={}, pid={pid}, bundle_id={} (responsible process)",
            self.executable.as_deref().unwrap_or("unknown"),
            self.bundle_id.as_deref().unwrap_or("unknown")
        )
    }
}

#[derive(Default)]
struct Settings {
    screen_recording: OnceLock<bool>,
    accessibility: OnceLock<bool>,
}

impl Settings {
    fn open_settings_once(
        &self,
        permission: TccPermission,
        opener: impl FnOnce(&str) -> bool,
    ) -> bool {
        let opened = match permission {
            TccPermission::ScreenRecording => &self.screen_recording,
            TccPermission::Accessibility => &self.accessibility,
        };
        *opened.get_or_init(|| opener(settings_url(permission)))
    }
}

static SETTINGS: Settings = Settings {
    screen_recording: OnceLock::new(),
    accessibility: OnceLock::new(),
};

#[cfg(not(test))]
fn open_settings(url: &str) -> bool {
    match std::process::Command::new("/usr/bin/open")
        .arg(url)
        .status()
    {
        Ok(status) => status.success(),
        Err(error) => {
            eprintln!("cannot open macOS privacy settings: {error}");
            false
        }
    }
}

// Unit tests simulate denied capture without touching the test runner's desktop.
#[cfg(test)]
fn open_settings(_: &str) -> bool {
    true
}

pub(crate) fn permission_denied(permission: TccPermission) -> DesktopError {
    let opened = SETTINGS.open_settings_once(permission, open_settings);
    denial(permission, host_app_name(), opened)
}

fn denial(permission: TccPermission, app: String, opened: bool) -> DesktopError {
    let pane = match permission {
        TccPermission::ScreenRecording => "Screen Recording",
        TccPermission::Accessibility => "Accessibility",
    };
    let url = settings_url(permission);
    let identity = responsible_identity().diagnostic();
    let opening = if opened {
        "has been opened"
    } else {
        "could not be opened automatically; open it"
    };
    let message = format!(
        "macOS {pane} is not granted for {app}. System Settings > Privacy & Security > {pane} \
         {opening} ({url}): enable \"{app}\", then fully quit and relaunch {app} before retrying. \
         ({identity})"
    );
    DesktopError::permission_denied_with(
        PermissionDeniedData {
            permission,
            settings_url: url.to_owned(),
            app,
            relaunch_required: true,
        },
        message,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn opens_each_permission_once_even_after_repeated_denials() {
        let settings = Settings::default();
        let opened = RefCell::new(Vec::new());
        let opener = |url: &str| {
            opened.borrow_mut().push(url.to_owned());
            true
        };
        for permission in [
            TccPermission::ScreenRecording,
            TccPermission::ScreenRecording,
            TccPermission::Accessibility,
            TccPermission::Accessibility,
        ] {
            assert!(settings.open_settings_once(permission, opener));
        }
        assert_eq!(
            *opened.borrow(),
            [
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            ]
        );
    }

    #[test]
    fn failed_open_is_not_retried_and_keeps_its_failure_state() {
        let settings = Settings::default();
        assert!(!settings.open_settings_once(TccPermission::Accessibility, |_| false));
        assert!(!settings.open_settings_once(TccPermission::Accessibility, |_| panic!("retry")));
    }

    #[test]
    fn absent_and_empty_host_names_use_the_launcher_phrase() {
        for value in [None, Some(String::new()), Some("  ".to_owned())] {
            assert_eq!(launcher_name(value), LAUNCHER);
        }
        assert_eq!(launcher_name(Some("QA App".to_owned())), "QA App");
        let error = denial(TccPermission::ScreenRecording, launcher_name(None), true);
        assert_eq!(error.permission.unwrap().app, LAUNCHER);
    }

    #[test]
    fn accessibility_error_carries_the_settings_contract() {
        let error = denial(TccPermission::Accessibility, "QA App".to_owned(), true);
        let data = error.permission.unwrap();
        assert_eq!(data.permission, TccPermission::Accessibility);
        assert_eq!(
            data.settings_url,
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        );
        assert_eq!(data.app, "QA App");
        assert!(data.relaunch_required);
    }
    #[test]
    fn responsible_app_identity_uses_its_path_pid_and_bundle() {
        let identity = ResponsibleIdentity {
            pid: Some(42),
            executable: Some("/Applications/QA.app/Contents/MacOS/QA".to_owned()),
            bundle_id: Some("dev.qa.app".to_owned()),
        };
        assert_eq!(identity.diagnostic(), "TCC identity: executable=/Applications/QA.app/Contents/MacOS/QA, pid=42, bundle_id=dev.qa.app (responsible process)");
    }

    #[test]
    fn responsible_non_bundle_process_does_not_guess_bundle_id() {
        let identity = ResponsibleIdentity {
            pid: Some(7),
            executable: Some("/usr/bin/ssh".to_owned()),
            bundle_id: None,
        };
        assert!(identity
            .diagnostic()
            .contains("executable=/usr/bin/ssh, pid=7, bundle_id=unknown"));
    }

    #[test]
    fn unresolved_responsible_identity_stays_unknown() {
        assert_eq!(ResponsibleIdentity::default().diagnostic(),
            "TCC identity: executable=unknown, pid=unknown, bundle_id=unknown (responsible process)");
        let identity = ResponsibleIdentity {
            pid: Some(9),
            ..ResponsibleIdentity::default()
        };
        assert!(identity
            .diagnostic()
            .contains("executable=unknown, pid=9, bundle_id=unknown"));
    }
}
