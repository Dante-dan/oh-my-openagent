use super::{present_exclusions, supported};

#[test]
fn helper_closed_before_capture_is_dropped_instead_of_failing_the_frame() {
    // Given: three helper IDs, one of which closed after enumeration.
    let live = [11_u32, 33];
    // When: exclusions are matched against the content snapshot.
    let present = present_exclusions(&[11, 22, 33], |id| live.contains(&id));
    // Then: only live helpers are excluded and the vanished one does not error.
    assert_eq!(present, [11, 33]);
}

#[test]
fn exclusion_api_presence_matches_the_running_macos_major_version() {
    // Given: the host's macOS major version.
    let output = std::process::Command::new("sw_vers").arg("-productVersion").output()
        .expect("sw_vers runs on every macOS host");
    let version = String::from_utf8(output.stdout).expect("sw_vers prints UTF-8");
    let major: u32 = version.trim().split('.').next().and_then(|m| m.parse().ok())
        .expect("sw_vers prints a numeric major version");
    // When / Then: the native probe agrees with the documented macOS 14 floor.
    assert_eq!(supported(), major >= 14, "macOS {version}");
}
