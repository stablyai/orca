//! Minimal adapter configuration registry replacing OpenIDEA `ide-language`
//! so `ide-dap` builds without pulling in 35 tree-sitter grammars.

use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct DebuggerConfig {
    pub target_placement: Option<String>,
    pub adapter: String,
    pub command: String,
    pub args: Vec<String>,
    pub transport: String,
    pub connect: Option<String>,
    pub install_hint: Option<String>,
    pub pinned: Option<ProgramPin>,
}

/// An approved adapter executable whose file hash is verified before launch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProgramPin {
    pub path: PathBuf,
    pub hash: String,
}

fn fnv1a_128_hex(bytes: &[u8]) -> String {
    let mut hash: u128 = 0x6c62272e07bb0142_62b821756295c58d;
    for &b in bytes {
        hash ^= u128::from(b);
        hash = hash.wrapping_mul(0x0000000001000000_000000000000013b);
    }
    format!("{hash:032x}")
}

impl ProgramPin {
    pub fn approve(path: impl Into<PathBuf>) -> std::io::Result<Self> {
        let path = path.into();
        let bytes = std::fs::read(&path)?;
        Ok(Self { path, hash: fnv1a_128_hex(&bytes) })
    }

    pub fn verify(&self) -> Result<&Path, String> {
        match std::fs::read(&self.path) {
            Ok(bytes) if fnv1a_128_hex(&bytes) == self.hash => Ok(&self.path),
            Ok(_) => Err(format!("{} changed since it was approved", self.path.display())),
            Err(e) => Err(format!("{}: {e}", self.path.display())),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct AdapterRegistry {
    configs: Vec<DebuggerConfig>,
}

impl AdapterRegistry {
    pub fn empty() -> Self {
        Self { configs: Vec::new() }
    }

    pub fn from_configs(configs: Vec<DebuggerConfig>) -> Self {
        Self { configs }
    }

    pub fn find(&self, adapter: &str) -> Option<DebuggerConfig> {
        self.configs.iter().find(|c| c.adapter == adapter).cloned()
    }
}
