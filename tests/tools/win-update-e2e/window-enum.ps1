<#
  window-enum.ps1 — enumerate visible top-level windows with owner attribution.

  Dot-source this file, then call Get-VisibleTopLevelWindows. It returns objects
  { handle, pid, processName, title } for every visible, non-cloaked top-level
  window that has a title.

  WHY window enumeration (and never conhost command-line heuristics): the July
  2026 post-mortem proved that (a) conhost flag interpretation inverts depending
  on the parent's console state, and (b) MainWindowHandle is 0 for
  Windows-Terminal-hosted consoles, so handle-based "is it visible" checks read
  a visibly-flashing window as hidden. The only sound signal is a real visible
  top-level window, attributed to an owner process and (for our own children) a
  canary title. This function is the single instrument every probe shares.
#>

# Compile the P/Invoke enumerator once. Guard on the type already existing so
# repeated dot-sourcing inside the watch loop does not re-run Add-Type (which
# throws on a duplicate type).
if (-not ('OrcaWinEnum.Native' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace OrcaWinEnum {
  public static class Native {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);

    // DWMWA_CLOAKED: a window can be IsWindowVisible()==true yet cloaked by the
    // shell (e.g. background UWP hosts). Cloaked windows are not really on
    // screen, so we skip them to keep the baseline diff free of ghost churn.
    private const int DWMWA_CLOAKED = 14;

    public static string[] Enumerate() {
      var rows = new List<string>();
      EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
        if (!IsWindowVisible(hWnd)) { return true; }
        int len = GetWindowTextLength(hWnd);
        if (len <= 0) { return true; }
        int cloaked = 0;
        try { DwmGetWindowAttribute(hWnd, DWMWA_CLOAKED, out cloaked, sizeof(int)); } catch { }
        if (cloaked != 0) { return true; }
        var sb = new StringBuilder(len + 1);
        GetWindowText(hWnd, sb, sb.Capacity);
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        // Tab-separated: handle, pid, title. Titles never contain a tab, and
        // the handle/pid are numeric, so this parses unambiguously downstream.
        rows.Add(((long)hWnd).ToString() + "\t" + pid.ToString() + "\t" + sb.ToString());
        return true;
      }, IntPtr.Zero);
      return rows.ToArray();
    }
  }
}
'@
}

function Get-VisibleTopLevelWindows {
  # @() forces an array even when Enumerate() returns a single row — the PS 5.1
  # single-item unwrap pitfall that caused a production incident when a count
  # of "1" silently became a scalar.
  $rows = @([OrcaWinEnum.Native]::Enumerate())

  # Cache pid -> process name so we resolve each owning process at most once.
  $nameByPid = @{}
  $result = New-Object System.Collections.Generic.List[object]

  foreach ($row in $rows) {
    $parts = $row -split "`t", 3
    if ($parts.Count -lt 3) { continue }
    $handle = [long]$parts[0]
    $procId = [int]$parts[1]
    $title = $parts[2]

    if (-not $nameByPid.ContainsKey($procId)) {
      $procName = $null
      try {
        $procName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName
      } catch {
        $procName = $null
      }
      $nameByPid[$procId] = $procName
    }

    $result.Add([pscustomobject]@{
      handle = $handle
      pid = $procId
      processName = $nameByPid[$procId]
      title = $title
    })
  }

  # Return the raw array; callers wrap with @() to normalize the PS 5.1
  # single-item unwrap. (Do not use the comma operator here — combined with a
  # caller's @() it produces a nested array.)
  return $result.ToArray()
}

# When run directly (not dot-sourced) emit the snapshot as JSON so this file
# doubles as the baseline-snapshot tool. Wrapped in an object with a `windows`
# array; the JS side normalizes single-element results because PS 5.1
# ConvertTo-Json unwraps a one-element array to a bare object.
if ($MyInvocation.InvocationName -ne '.') {
  [pscustomobject]@{ windows = @(Get-VisibleTopLevelWindows) } |
    ConvertTo-Json -Depth 4 -Compress
}
