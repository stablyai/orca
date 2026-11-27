# Waits for an installer message box whose text contains -TextMatch, then presses its OK (1) or
# Cancel (2) button by message, without needing focus. Prints JSON {found, text, pressed}.
param(
  [Parameter(Mandatory = $true)][int]$InstallerPid,
  [Parameter(Mandatory = $true)][string]$TextMatch,
  [ValidateSet('ok', 'cancel', 'none')][string]$Press = 'none',
  [int]$TimeoutSec = 90
)

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class OrcaInstallerDialog {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  static string TextOf(IntPtr h) { var sb = new StringBuilder(2048); GetWindowText(h, sb, 2048); return sb.ToString(); }
  // Returns "hwnd|text" for the first #32770 dialog of pid holding a Static child that contains match.
  public static string Find(uint pid, string match) {
    string found = null;
    EnumWindows((h, _) => {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner != pid || ClassOf(h) != "#32770") return true;
      var texts = new List<string>();
      EnumChildWindows(h, (c, __) => { if (ClassOf(c) == "Static") texts.Add(TextOf(c)); return true; }, IntPtr.Zero);
      foreach (var t in texts) {
        if (t.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0) { found = h.ToInt64() + "|" + t; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$hit = $null
while ((Get-Date) -lt $deadline -and -not $hit) {
  if (-not (Get-Process -Id $InstallerPid -ErrorAction SilentlyContinue)) { break }
  $hit = [OrcaInstallerDialog]::Find([uint32]$InstallerPid, $TextMatch)
  if (-not $hit) { Start-Sleep -Milliseconds 250 }
}
if (-not $hit) {
  [pscustomobject]@{ found = $false; text = $null; pressed = $null } | ConvertTo-Json -Compress
  exit 0
}
$parts = $hit.Split('|', 2)
$hwnd = [IntPtr][long]$parts[0]
if ($Press -ne 'none') {
  # WM_COMMAND with IDOK (1) or IDCANCEL (2), as a click on that button sends.
  $id = if ($Press -eq 'ok') { 1 } else { 2 }
  [void][OrcaInstallerDialog]::PostMessage($hwnd, 0x0111, [IntPtr]$id, [IntPtr]::Zero)
}
[pscustomobject]@{ found = $true; text = $parts[1]; pressed = $Press } | ConvertTo-Json -Compress
