//! Version managers that keep one install per tool version (mise, asdf): where their
//! installs and shims live. SDK detection lists the installs; child processes get the
//! shims on `PATH` when the manager's shell hook didn't run (an app started from the Dock,
//! `mise activate` only in an interactive rc file).

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

pub const MISE: &str = "mise";
pub const ASDF: &str = "asdf";

/// A toolchain the version managers install.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tool {
    Java,
    Node,
    Python,
    Go,
    Maven,
    Gradle,
    Ruby,
}

impl Tool {
    /// The tool's names in mise and asdf plugins (`nodejs`, `golang` are asdf's).
    pub fn names(self) -> &'static [&'static str] {
        match self {
            Tool::Java => &["java"],
            Tool::Node => &["node", "nodejs"],
            Tool::Python => &["python"],
            Tool::Go => &["go", "golang"],
            Tool::Maven => &["maven"],
            Tool::Gradle => &["gradle"],
            Tool::Ruby => &["ruby"],
        }
    }
}

/// One version manager's data directory (`installs/`, `shims/`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Manager {
    pub name: &'static str,
    pub dir: PathBuf,
}

impl Manager {
    pub fn shims(&self) -> PathBuf {
        self.dir.join("shims")
    }

    /// `installs/<tool>/<version>` directories of `tool`, sorted. The alias links mise
    /// adds next to an install (`21 -> ./21.0.2`, `latest`) are left out; a link to an
    /// install elsewhere (`mise link`) is kept.
    pub fn installs(&self, tool: Tool) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for name in tool.names() {
            let Ok(entries) = std::fs::read_dir(self.dir.join("installs").join(name)) else { continue };
            for e in entries.flatten() {
                let path = e.path();
                let alias = e.file_type().is_ok_and(|t| t.is_symlink())
                    && std::fs::read_link(&path).is_ok_and(|t| t.is_relative() && t.components().count() <= 2);
                if !alias && path.is_dir() {
                    out.push(path);
                }
            }
        }
        out.sort();
        out
    }

    /// The install of `tool` named `version` exactly (alias links included).
    pub fn install_named(&self, tool: Tool, version: &str) -> Option<PathBuf> {
        if version.is_empty() || version.contains(['/', '\\']) || version.starts_with('.') {
            return None;
        }
        tool.names().iter().map(|n| self.dir.join("installs").join(n).join(version)).find(|p| p.is_dir())
    }
}

/// mise's and asdf's data directories that exist, as this process's environment (and the
/// login shell's) set them.
pub fn managers() -> Vec<Manager> {
    let lookup = |k: &str| {
        crate::process::host_var_os(k)
            .or_else(|| crate::process::login_env()?.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()))
    };
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    managers_with(&lookup, home.as_deref()).into_iter().filter(|m| m.dir.is_dir()).collect()
}

/// mise: `MISE_DATA_DIR`, else `$XDG_DATA_HOME/mise`, else `~/.local/share/mise`
/// (`%LOCALAPPDATA%\mise` on Windows). asdf: `ASDF_DATA_DIR`, else `~/.asdf`.
pub fn managers_with(env: &dyn Fn(&str) -> Option<OsString>, home: Option<&Path>) -> Vec<Manager> {
    let var = |k: &str| env(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    let mise = var("MISE_DATA_DIR")
        .or_else(|| var("XDG_DATA_HOME").map(|d| d.join("mise")))
        .or_else(|| if cfg!(windows) { var("LOCALAPPDATA").map(|d| d.join("mise")) } else { None })
        .or_else(|| home.map(|h| h.join(".local/share/mise")));
    let asdf = var("ASDF_DATA_DIR").or_else(|| home.map(|h| h.join(".asdf")));
    let mut out = Vec::new();
    out.extend(mise.map(|dir| Manager { name: MISE, dir }));
    out.extend(asdf.map(|dir| Manager { name: ASDF, dir }));
    out
}

/// Every install of `tool` with the manager it came from, mise's first.
pub fn installs(tool: Tool) -> Vec<(PathBuf, &'static str)> {
    managers().iter().flat_map(|m| m.installs(tool).into_iter().map(|p| (p, m.name))).collect()
}

/// The manager whose installs `path` lies in.
pub fn manager_of(path: &Path) -> Option<&'static str> {
    manager_in(&managers(), path)
}

pub fn manager_in(managers: &[Manager], path: &Path) -> Option<&'static str> {
    managers.iter().find_map(|m| {
        let installs = m.dir.join("installs");
        let real = dunce::canonicalize(&installs).ok();
        (path.starts_with(&installs) || real.is_some_and(|r| path.starts_with(r))).then_some(m.name)
    })
}

/// Whether `path` is a version manager's shim (it picks the version by the working directory).
pub fn is_shim(path: &Path) -> bool {
    path.parent().is_some_and(is_shims_dir)
}

/// Whether `dir` is a version manager's `shims` folder.
pub fn is_shims_dir(dir: &Path) -> bool {
    managers().iter().any(|m| m.shims() == dir)
}

/// `path` (a `PATH` value) with the shims of a manager it doesn't reach yet: mise's in
/// front (a mise shim runs the next tool on `PATH` when no version is set), asdf's at the
/// end (an asdf shim fails then). A `PATH` that has a manager's shims or installs already
/// (its shell hook ran) is left as it is for that manager.
pub fn path_with_shims(managers: &[Manager], path: &OsStr) -> OsString {
    let mut dirs: Vec<PathBuf> = if path.is_empty() { Vec::new() } else { std::env::split_paths(path).collect() };
    let before = dirs.len();
    for m in managers {
        let shims = m.shims();
        let installs = m.dir.join("installs");
        if !shims.is_dir() || dirs.iter().any(|d| d == &shims || d.starts_with(&installs)) {
            continue;
        }
        if m.name == MISE {
            dirs.insert(0, shims);
        } else {
            dirs.push(shims);
        }
    }
    if dirs.len() == before {
        return path.to_owned();
    }
    std::env::join_paths(dirs).unwrap_or_else(|_| path.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn mkdir(p: &Path) {
        std::fs::create_dir_all(p).unwrap();
    }

    #[test]
    fn data_dirs_follow_the_environment() {
        let home = Path::new("/home/me");
        let none = |_: &str| None;
        let dirs: Vec<_> = managers_with(&none, Some(home)).into_iter().map(|m| (m.name, m.dir)).collect();
        if !cfg!(windows) {
            assert_eq!(dirs[0], (MISE, home.join(".local/share/mise")));
        }
        assert_eq!(dirs[1], (ASDF, home.join(".asdf")));

        let xdg = |k: &str| (k == "XDG_DATA_HOME").then(|| OsString::from("/xdg"));
        assert_eq!(managers_with(&xdg, Some(home))[0].dir, Path::new("/xdg/mise"));

        let custom = |k: &str| match k {
            "MISE_DATA_DIR" => Some(OsString::from("/opt/mise")),
            "XDG_DATA_HOME" => Some(OsString::from("/xdg")),
            "ASDF_DATA_DIR" => Some(OsString::from("/opt/asdf")),
            _ => None,
        };
        let dirs: Vec<_> = managers_with(&custom, Some(home)).into_iter().map(|m| m.dir).collect();
        assert_eq!(dirs, [PathBuf::from("/opt/mise"), PathBuf::from("/opt/asdf")]);
    }

    #[cfg(unix)]
    #[test]
    fn installs_skip_alias_links() {
        let tmp = tempfile::tempdir().unwrap();
        let mise = Manager { name: MISE, dir: tmp.path().join("mise") };
        let node = mise.dir.join("installs/node");
        mkdir(&node.join("20.11.0"));
        mkdir(&node.join("22.1.0"));
        std::os::unix::fs::symlink("./22.1.0", node.join("22")).unwrap();
        std::os::unix::fs::symlink("./22.1.0", node.join("latest")).unwrap();
        let elsewhere = tmp.path().join("opt-node");
        mkdir(&elsewhere);
        std::os::unix::fs::symlink(&elsewhere, node.join("linked")).unwrap();
        std::fs::write(node.join(".mise.backend.toml"), "").unwrap();

        let names: Vec<_> =
            mise.installs(Tool::Node).iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["20.11.0", "22.1.0", "linked"]);
        assert_eq!(mise.install_named(Tool::Node, "22"), Some(node.join("22")));
        assert_eq!(mise.install_named(Tool::Node, "18"), None);
        assert_eq!(mise.install_named(Tool::Node, "../node"), None);

        // asdf's plugin names.
        let asdf = Manager { name: ASDF, dir: tmp.path().join("asdf") };
        mkdir(&asdf.dir.join("installs/golang/1.22.1"));
        assert_eq!(asdf.installs(Tool::Go), [asdf.dir.join("installs/golang/1.22.1")]);
        assert_eq!(manager_in(&[mise.clone(), asdf.clone()], &node.join("20.11.0/bin/node")), Some(MISE));
        assert_eq!(manager_in(&[mise, asdf], tmp.path()), None);
    }

    #[cfg(unix)]
    #[test]
    fn shims_join_a_path_the_hook_did_not_set() {
        let tmp = tempfile::tempdir().unwrap();
        let mise = Manager { name: MISE, dir: tmp.path().join("mise") };
        let asdf = Manager { name: ASDF, dir: tmp.path().join("asdf") };
        let managers = [mise.clone(), asdf.clone()];
        let path = OsString::from("/usr/bin:/bin");
        assert_eq!(path_with_shims(&managers, &path), path, "no shims installed");

        mkdir(&mise.shims());
        mkdir(&asdf.shims());
        let got = path_with_shims(&managers, &path);
        let want = format!("{}:/usr/bin:/bin:{}", mise.shims().display(), asdf.shims().display());
        assert_eq!(got, OsString::from(want));
        assert_eq!(path_with_shims(&managers, &got), got, "applied once");

        // `mise activate` put an install on PATH: mise is active, only asdf's shims join.
        let active = format!("{}:/usr/bin", mise.dir.join("installs/node/22.1.0/bin").display());
        let got = path_with_shims(&managers, OsStr::new(&active));
        assert_eq!(got, OsString::from(format!("{active}:{}", asdf.shims().display())));
    }
}
