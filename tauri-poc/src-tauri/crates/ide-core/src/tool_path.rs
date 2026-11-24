//! Where the IDE looks up the executables it runs: language servers, the tools
//! their settings come from, installers. An app started from the desktop gets a
//! minimal `PATH`, and version managers set theirs up in shell rc files.

use crate::process::{host_var_os, login_env};
use crate::version_managers;
use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// Where executables are looked up: this process's `PATH` (the login shell's in the
/// app), the login shell's `PATH` as last read, then per-user directories and mise's,
/// asdf's and pyenv's shims, for when the shell's setup didn't reach the app. Language server
/// launchers, their settings hooks and tool detection all look here, so a settings
/// hook finds the executable its server is launched from.
pub fn search_path() -> OsString {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    let shell_path = login_env().and_then(|env| env.iter().find(|(k, _)| k == "PATH").map(|(_, v)| v.clone()));
    let shims: Vec<PathBuf> = version_managers::managers().iter().map(|m| m.shims()).collect();
    // The Windows user `PATH` may not reach a process started before it was set; append its
    // entries after the inherited ones so missing user tools still resolve.
    let user_path = crate::process::user_path();
    let dirs = search_dirs(
        host_var_os("PATH").as_deref(),
        shell_path.as_deref(),
        user_path.as_deref(),
        home.as_deref(),
        &shims,
    );
    std::env::join_paths(dirs).unwrap_or_default()
}

/// Ruby code printing where `gem install` puts executables: the Ruby's own `Gem.bindir`, which
/// Homebrew's Ruby keeps off `PATH`, and the `--user-install` one.
pub const RUBY_GEM_BIN_SCRIPT: &str = "puts Gem.bindir, File.join(Gem.user_dir, 'bin')";

/// The directories [`RUBY_GEM_BIN_SCRIPT`] printed that exist.
pub fn gem_bin_dirs(output: &str) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for dir in output.lines().map(str::trim).map(PathBuf::from) {
        if dir.is_absolute() && dir.is_dir() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

/// Resolves a command on the shared path, or an explicit path relative to `root`.
pub fn find_command(command: &str, search: &OsStr, root: &Path) -> Option<PathBuf> {
    let path = Path::new(command);
    let explicit = path.parent().is_some_and(|p| !p.as_os_str().is_empty());
    let pathext = host_var_os("PATHEXT");
    let names = crate::process::executable_names(command, cfg!(windows), pathext.as_deref().and_then(OsStr::to_str));
    let dirs = if explicit {
        vec![root.to_path_buf()]
    } else {
        std::env::split_paths(search).filter(|p| !p.as_os_str().is_empty()).map(|p| root.join(p)).collect()
    };
    dirs.into_iter().find_map(|dir| names.iter().map(|name| dir.join(name)).find(|p| is_executable(p)))
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else { return false };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    true
}

/// [`search_path`]'s directories, in order and once each. Only absolute ones: a
/// relative entry (`.`, `node_modules/.bin`) resolves against the project, which
/// could then supply the tools the IDE runs. One that can't be joined (a `:` in a
/// directory name) is left out rather than failing the whole path.
fn search_dirs(
    process_path: Option<&OsStr>,
    shell_path: Option<&OsStr>,
    user_path: Option<&OsStr>,
    home: Option<&Path>,
    shims: &[PathBuf],
) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> =
        process_path.into_iter().chain(shell_path).chain(user_path).flat_map(std::env::split_paths).collect();
    if let Some(home) = home {
        dirs.extend(USER_DIRS.iter().map(|d| home.join(d)));
        dirs.extend(nvm_bins(&home.join(".nvm/versions/node")));
    }
    // Version managers' shims after real tool directories: a shim exists for a command any
    // installed version has, and fails when the selected one lacks it. Before the system's,
    // as the managers' shell setup puts them.
    dirs.extend(home.map(|h| h.join(".pyenv/shims")));
    dirs.extend(shims.iter().cloned());
    dirs.extend(SYSTEM_DIRS.iter().map(PathBuf::from));
    let mut seen = HashSet::new();
    dirs.retain(|d| d.is_absolute() && std::env::join_paths([d]).is_ok() && seen.insert(d.clone()));
    dirs
}

/// Tool directories below the home directory.
const USER_DIRS: &[&str] = &[
    ".cargo/bin",
    ".local/bin",
    "go/bin",
    // `dotnet tool install --global` puts fsautocomplete, csharp-ls and friends here.
    ".dotnet/tools",
    ".bun/bin",
    ".deno/bin",
    ".npm-global/bin",
    ".volta/bin",
    // Set up in shell rc files: fnm's default Node and pnpm's global bin (Linux, then macOS).
    ".local/share/fnm/aliases/default/bin",
    "Library/Application Support/fnm/aliases/default/bin",
    ".fnm/aliases/default/bin",
    ".local/share/pnpm/bin",
    ".local/share/pnpm",
    "Library/pnpm/bin",
    "Library/pnpm",
];

const SYSTEM_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/go/bin", "/usr/local/bin", "/usr/bin", "/bin"];

/// Whether `dir` is one of the system's own bin directories, which [`search_path`] adds
/// whatever `PATH` holds.
pub fn is_system_dir(dir: &Path) -> bool {
    SYSTEM_DIRS.iter().any(|d| Path::new(d) == dir)
}

/// The `bin` directories of nvm's Node versions in `dir`, newest first.
fn nvm_bins(dir: &Path) -> Vec<PathBuf> {
    let mut versions: Vec<(Vec<u64>, PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| (version_key(&e.file_name().to_string_lossy()), e.path().join("bin")))
        .collect();
    versions.sort();
    versions.into_iter().rev().map(|(_, bin)| bin).collect()
}

/// `v22.10.1` as `[22, 10, 1]`: v22 is newer than v9, v20.10 newer than v20.9.
pub fn version_key(name: &str) -> Vec<u64> {
    name.trim_start_matches('v').split('.').map(|n| n.parse().unwrap_or(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_resolve_on_path_and_explicit_paths_under_root() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let name = if cfg!(windows) { "ngserver.cmd" } else { "ngserver" };
        std::fs::write(bin.join(name), "").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(bin.join(name), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let search = std::env::join_paths([&bin]).unwrap();
        assert_eq!(find_command("ngserver", &search, dir.path()), Some(bin.join(name)));
        assert_eq!(find_command("bin/ngserver", &search, dir.path()), Some(bin.join(name)));
        assert_eq!(find_command(bin.join(name).to_str().unwrap(), &search, dir.path()), Some(bin.join(name)));
        assert_eq!(find_command("absent", &search, dir.path()), None);
        for command in ["bin/ngserver", bin.join(name).to_str().unwrap()] {
            assert_eq!(find_command(command, OsStr::new(""), dir.path()), Some(bin.join(name)));
        }
    }

    #[cfg(unix)]
    #[test]
    fn non_executable_files_do_not_shadow_commands() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dirs = [tmp.path().join("first"), tmp.path().join("second")];
        for (dir, mode) in dirs.iter().zip([0o644, 0o755]) {
            std::fs::create_dir(dir).unwrap();
            let file = dir.join("ngserver");
            std::fs::write(&file, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(mode)).unwrap();
        }
        let path = std::env::join_paths(&dirs).unwrap();
        assert_eq!(find_command("ngserver", &path, tmp.path()), Some(dirs[1].join("ngserver")));
        assert_eq!(find_command("first/ngserver", &path, tmp.path()), None);
    }

    #[cfg(unix)]
    #[test]
    fn search_dirs_put_the_process_path_first_and_shims_after_real_tools() {
        let shims = [PathBuf::from("/home/me/.local/share/mise/shims"), "/home/me/.asdf/shims".into()];
        let dirs = search_dirs(
            Some(OsStr::new("/usr/bin:.:node_modules/.bin:/opt/tools")),
            // nushell prints `$PATH` as is.
            Some(OsStr::new("$PATH:/opt/tools:/home/me/.asdf/shims")),
            None,
            Some(Path::new("/home/me")),
            &shims,
        );
        let at = |d: &str| dirs.iter().position(|p| p == Path::new(d)).unwrap();
        assert_eq!(dirs[..3], [PathBuf::from("/usr/bin"), "/opt/tools".into(), "/home/me/.asdf/shims".into()]);
        assert!(at("/home/me/.npm-global/bin") < at("/home/me/.pyenv/shims"));
        // Global .NET tools (fsautocomplete, csharp-ls) install here, off PATH.
        assert!(at("/home/me/.dotnet/tools") < at("/usr/local/bin"));
        assert!(at("/home/me/.local/share/mise/shims") < at("/usr/local/bin"));
        assert!(dirs.iter().all(|d| d.is_absolute()));
        let unique: HashSet<&PathBuf> = dirs.iter().collect();
        assert_eq!(unique.len(), dirs.len());
        // A `:` can't be in a `PATH` entry: those below such a home are left out.
        let dirs = search_dirs(Some(OsStr::new("/usr/bin")), None, None, Some(Path::new("/home/a:b")), &[]);
        assert!(dirs.contains(&PathBuf::from("/usr/bin")) && !dirs.iter().any(|d| d.starts_with("/home")));
    }

    #[test]
    fn search_dirs_append_user_path_entries_once_after_the_inherited_path() {
        let (system, dup, usertool) =
            if cfg!(windows) { ("C:/system", "C:/dup", "C:/usertool") } else { ("/system", "/dup", "/usertool") };
        let home = Path::new(if cfg!(windows) { "C:/home/me" } else { "/home/me" });
        let join = |dirs: &[&str]| std::env::join_paths(dirs.iter().map(PathBuf::from)).unwrap();
        let inherited = join(&[system, dup]);
        let user = join(&[dup, usertool]);
        let dirs = search_dirs(Some(inherited.as_os_str()), None, Some(user.as_os_str()), Some(home), &[]);
        let at = |d: &str| dirs.iter().position(|p| p == Path::new(d)).unwrap();
        // User entries follow the inherited PATH, de-duplicated, ahead of the fallbacks.
        assert_eq!(dirs.iter().filter(|d| *d == Path::new(dup)).count(), 1);
        assert!(at(dup) < at(usertool));
        // And before this platform's home/system fallbacks.
        let fallback = dirs.iter().position(|d| d == &home.join(USER_DIRS[0])).unwrap();
        assert!(at(usertool) < fallback);
    }

    #[test]
    fn nvm_versions_newest_first() {
        let dir = std::env::temp_dir().join(format!("openidea-nvm-{}", std::process::id()));
        for v in ["v9.11.2", "v20.9.0", "v22.1.0", "v20.10.0"] {
            std::fs::create_dir_all(dir.join(v).join("bin")).unwrap();
        }
        let bins = nvm_bins(&dir);
        std::fs::remove_dir_all(&dir).unwrap();
        let names: Vec<_> = bins.iter().map(|b| b.parent().unwrap().file_name().unwrap().to_owned()).collect();
        assert_eq!(names, ["v22.1.0", "v20.10.0", "v20.9.0", "v9.11.2"]);
    }
}
