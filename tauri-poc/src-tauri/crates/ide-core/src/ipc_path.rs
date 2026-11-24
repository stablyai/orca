//! Paths on the IPC boundary are `/`-separated on every OS, so the UI can split,
//! join and compare them without caring about Windows. Path fields of IPC types
//! are [`IpcPath`]: a `PathBuf` (derefs to `Path`) that serializes `C:\a\b` (and `\\?\C:\a\b`) as
//! `C:/a/b` and is a plain `string` in the generated bindings.
//!
//! Incoming paths need nothing: Windows accepts `C:/a/b`, and `Path` equality
//! and hashing are component-wise.

use std::borrow::Borrow;
use std::ops::Deref;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// `p` as the UI sees it: `C:\a\b` and `\\?\C:\a\b` become `C:/a/b`.
pub fn to_ipc(p: &Path) -> String {
    #[cfg(windows)]
    {
        dunce::simplified(p).to_string_lossy().replace('\\', "/")
    }
    #[cfg(not(windows))]
    {
        p.to_string_lossy().into_owned()
    }
}

/// A path field of an IPC type.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct IpcPath(pub PathBuf);

impl IpcPath {
    pub fn into_path_buf(self) -> PathBuf {
        self.0
    }
}

impl Serialize for IpcPath {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&to_ipc(&self.0))
    }
}

impl<'de> Deserialize<'de> for IpcPath {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        PathBuf::deserialize(d).map(Self)
    }
}

impl Deref for IpcPath {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for IpcPath {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Borrow<Path> for IpcPath {
    fn borrow(&self) -> &Path {
        &self.0
    }
}

impl From<PathBuf> for IpcPath {
    fn from(p: PathBuf) -> Self {
        Self(p)
    }
}

impl From<&Path> for IpcPath {
    fn from(p: &Path) -> Self {
        Self(p.to_path_buf())
    }
}

impl From<&PathBuf> for IpcPath {
    fn from(p: &PathBuf) -> Self {
        Self(p.clone())
    }
}

impl From<String> for IpcPath {
    fn from(p: String) -> Self {
        Self(p.into())
    }
}

impl From<&str> for IpcPath {
    fn from(p: &str) -> Self {
        Self(p.into())
    }
}

impl From<IpcPath> for PathBuf {
    fn from(p: IpcPath) -> Self {
        p.0
    }
}

impl PartialEq<PathBuf> for IpcPath {
    fn eq(&self, other: &PathBuf) -> bool {
        self.0 == *other
    }
}

impl PartialEq<Path> for IpcPath {
    fn eq(&self, other: &Path) -> bool {
        self.0 == other
    }
}

impl PartialEq<&Path> for IpcPath {
    fn eq(&self, other: &&Path) -> bool {
        self.0 == *other
    }
}

impl PartialEq<IpcPath> for PathBuf {
    fn eq(&self, other: &IpcPath) -> bool {
        *self == other.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_json() {
        let p = IpcPath::from("a/b");
        assert_eq!(serde_json::to_string(&p).unwrap(), r#""a/b""#);
        assert_eq!(serde_json::from_str::<IpcPath>(r#""a/b""#).unwrap(), p);
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_use_forward_slashes() {
        assert_eq!(to_ipc(Path::new(r"C:\a\b")), "C:/a/b");
        assert_eq!(to_ipc(Path::new(r"\\?\C:\a\b")), "C:/a/b");
        assert_eq!(to_ipc(&Path::new("C:/a").join("b")), "C:/a/b");
        assert_eq!(serde_json::to_string(&IpcPath::from(r"C:\a\b")).unwrap(), r#""C:/a/b""#);
    }
}
