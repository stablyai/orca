<#
  Dot-source Get-VisibleTopLevelWindows: { handle, pid, processName, title } for titled, visible, non-cloaked windows.
  July 2026 evidence: conhost flags invert with parent console state and Windows Terminal leaves
  MainWindowHandle=0 despite visible consoles. Attribute real top-level windows by process/canary title.
#>

# Compile once: repeated dot-sourcing must not duplicate Add-Type.
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
  # PS 5.1 unwraps one-row results; @() preserves array/count semantics.
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

  # Callers normalize with @(); return raw array to avoid comma-created nested arrays.
  return $result.ToArray()
}

# Direct invocation emits { windows: [...] } for baseline snapshots; JS normalizes PS 5.1’s single-result JSON unwrap.
if ($MyInvocation.InvocationName -ne '.') {
  [pscustomobject]@{ windows = @(Get-VisibleTopLevelWindows) } |
    ConvertTo-Json -Depth 4 -Compress
}
