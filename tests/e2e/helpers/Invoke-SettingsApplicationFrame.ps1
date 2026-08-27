[CmdletBinding()]
param(
    [ValidateSet('Launch', 'Close')]
    [string]$Action = 'Launch',

    [string]$Hwnd,

    [uint32]$FramePid,

    [uint32]$AppPid,

    [ValidateRange(1, 120000)]
    [int]$TimeoutMilliseconds = 15000
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not ('SettingsFrameLauncher' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

public sealed class SettingsFrameInfo
{
    public uint AppPid { get; internal set; }
    public uint FramePid { get; internal set; }
    public long FrameHwndValue { get; internal set; }
    public string FrameHwndHex
    {
        get { return "0x" + unchecked((ulong)FrameHwndValue).ToString("X"); }
    }
}

public static class SettingsFrameLauncher
{
    private const string SettingsAumid =
        "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel";

    private const uint CLSCTX_LOCAL_SERVER = 0x4;
    private const uint AO_NOERRORUI = 0x2;
    private const uint WM_CLOSE = 0x0010;
    private const uint COINIT_APARTMENTTHREADED = 0x2;

    private static readonly Guid ActivationManagerClsid =
        new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C");
    private static readonly Guid ActivationManagerIid =
        new Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D");

    [ComImport]
    [Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IApplicationActivationManager
    {
        [PreserveSig]
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            uint options,
            out uint processId);
    }

    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("ole32.dll", ExactSpelling = true)]
    private static extern int CoInitializeEx(IntPtr reserved, uint coInit);

    [DllImport("ole32.dll", ExactSpelling = true)]
    private static extern void CoUninitialize();

    [DllImport("ole32.dll", ExactSpelling = true)]
    private static extern int CoCreateInstance(
        ref Guid clsid,
        IntPtr outer,
        uint clsContext,
        ref Guid iid,
        out IntPtr instance);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumChildWindows(
        IntPtr parent,
        EnumWindowsProc callback,
        IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr hwnd);


    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    public static SettingsFrameInfo Launch(int timeoutMilliseconds)
    {
        if (timeoutMilliseconds <= 0)
            throw new ArgumentOutOfRangeException("timeoutMilliseconds");

        int initHr = CoInitializeEx(IntPtr.Zero, COINIT_APARTMENTTHREADED);
        bool uninitialize = initHr >= 0;
        if (initHr < 0)
            ThrowForHr(initHr, "CoInitializeEx");

        IntPtr rawManager = IntPtr.Zero;
        IApplicationActivationManager manager = null;

        try
        {
            Guid clsid = ActivationManagerClsid;
            Guid iid = ActivationManagerIid;
            int hr = CoCreateInstance(
                ref clsid,
                IntPtr.Zero,
                CLSCTX_LOCAL_SERVER,
                ref iid,
                out rawManager);
            ThrowForHr(hr, "CoCreateInstance(CLSID_ApplicationActivationManager)");

            manager = (IApplicationActivationManager)Marshal.GetObjectForIUnknown(rawManager);
            Marshal.Release(rawManager);
            rawManager = IntPtr.Zero;

            uint appPid;
            hr = manager.ActivateApplication(
                SettingsAumid,
                null,
                AO_NOERRORUI,
                out appPid);
            ThrowForHr(hr, "IApplicationActivationManager.ActivateApplication");

            Stopwatch timer = Stopwatch.StartNew();
            List<SettingsFrameInfo> last = new List<SettingsFrameInfo>();

            while (timer.ElapsedMilliseconds < timeoutMilliseconds)
            {
                last = FindFrames(appPid);
                if (last.Count == 1 && IsStillTheSameFrame(last[0]))
                    return last[0];

                if (!ProcessExists(appPid))
                    throw new InvalidOperationException(
                        "The Settings process returned by activation exited before its frame was found. PID=" + appPid);

                Thread.Sleep(50);
            }

            if (last.Count > 1)
                throw new InvalidOperationException(
                    "Activation returned Settings PID " + appPid +
                    ", but more than one visible ApplicationFrameHost window contains an HWND owned by that PID. " +
                    "The activation cannot be correlated to one window without an app-level token.");

            throw new TimeoutException(
                "Activation returned Settings PID " + appPid +
                ", but no visible ApplicationFrameHost top-level window containing an HWND owned by that PID appeared within " +
                timeoutMilliseconds + " ms.");
        }
        finally
        {
            if (manager != null && Marshal.IsComObject(manager))
                Marshal.FinalReleaseComObject(manager);
            if (rawManager != IntPtr.Zero)
                Marshal.Release(rawManager);
            if (uninitialize)
                CoUninitialize();
        }
    }

    public static string CloseFrameHex(
        string frameHwndHex,
        uint expectedFramePid,
        uint expectedAppPid,
        int timeoutMilliseconds)
    {
        if (string.IsNullOrWhiteSpace(frameHwndHex))
            throw new ArgumentException("A window handle is required.", "frameHwndHex");
        if (expectedFramePid == 0)
            throw new ArgumentOutOfRangeException("expectedFramePid");

        string value = frameHwndHex.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
            ? frameHwndHex.Substring(2)
            : frameHwndHex;

        ulong raw = ulong.Parse(value, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture);
        return CloseFrame(unchecked((long)raw), expectedFramePid, expectedAppPid, timeoutMilliseconds);
    }

    public static string CloseFrame(
        long frameHwndValue,
        uint expectedFramePid,
        uint expectedAppPid,
        int timeoutMilliseconds)
    {
        IntPtr hwnd = new IntPtr(frameHwndValue);
        if (!IsWindow(hwnd))
            return "AlreadyGone";

        if (!IsExpectedFrame(hwnd, expectedFramePid, expectedAppPid))
            return "IdentityMismatch";

        if (!PostMessage(hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero))
        {
            // The target may have closed between identity check and PostMessage.
            if (!IsExpectedFrame(hwnd, expectedFramePid, expectedAppPid))
                return "AlreadyGone";

            throw new Win32Exception(Marshal.GetLastWin32Error(), "PostMessage(WM_CLOSE) failed");
        }

        Stopwatch timer = Stopwatch.StartNew();
        while (IsExpectedFrame(hwnd, expectedFramePid, expectedAppPid) &&
               timer.ElapsedMilliseconds < timeoutMilliseconds)
            Thread.Sleep(50);

        if (IsExpectedFrame(hwnd, expectedFramePid, expectedAppPid))
            throw new TimeoutException(
                "The Settings frame did not close in time: HWND=" + frameHwndValue +
                ", PID=" + expectedFramePid);

        return "Closed";
    }

    private static bool IsExpectedFrame(IntPtr hwnd, uint expectedFramePid, uint expectedAppPid)
    {
        if (!IsWindow(hwnd))
            return false;

        uint ownerPid;
        if (GetWindowThreadProcessId(hwnd, out ownerPid) == 0 ||
            ownerPid != expectedFramePid ||
            !ProcessNameEquals(ownerPid, "ApplicationFrameHost"))
            return false;

        if (expectedAppPid != 0 && !HasDescendantOwnedBy(hwnd, expectedAppPid))
            return false;

        return true;
    }

    private static List<SettingsFrameInfo> FindFrames(uint appPid)
    {
        List<SettingsFrameInfo> result = new List<SettingsFrameInfo>();

        EnumWindowsProc topCallback = delegate(IntPtr top, IntPtr ignored)
        {
            if (!IsWindowVisible(top))
                return true;

            uint framePid;
            if (GetWindowThreadProcessId(top, out framePid) == 0 || framePid == 0 || framePid == appPid)
                return true;

            if (!ProcessNameEquals(framePid, "ApplicationFrameHost"))
                return true;

            if (!HasDescendantOwnedBy(top, appPid))
                return true;

            SettingsFrameInfo info = new SettingsFrameInfo();
            info.AppPid = appPid;
            info.FramePid = framePid;
            info.FrameHwndValue = top.ToInt64();
            result.Add(info);
            return true;
        };

        if (!EnumWindows(topCallback, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "EnumWindows failed");
        GC.KeepAlive(topCallback);
        return result;
    }

    private static bool HasDescendantOwnedBy(IntPtr parent, uint appPid)
    {
        bool found = false;

        EnumWindowsProc childCallback = delegate(IntPtr child, IntPtr ignored)
        {
            uint childPid;
            if (GetWindowThreadProcessId(child, out childPid) != 0 && childPid == appPid)
            {
                found = true;
                return false;
            }
            return true;
        };

        EnumChildWindows(parent, childCallback, IntPtr.Zero);
        GC.KeepAlive(childCallback);
        return found;
    }

    private static bool IsStillTheSameFrame(SettingsFrameInfo info)
    {
        IntPtr hwnd = new IntPtr(info.FrameHwndValue);
        if (!IsWindow(hwnd))
            return false;

        uint currentPid;
        if (GetWindowThreadProcessId(hwnd, out currentPid) == 0 || currentPid != info.FramePid)
            return false;

        return ProcessNameEquals(currentPid, "ApplicationFrameHost") &&
               HasDescendantOwnedBy(hwnd, info.AppPid);
    }


    private static bool ProcessNameEquals(uint pid, string expected)
    {
        try
        {
            using (Process process = Process.GetProcessById((int)pid))
                return string.Equals(process.ProcessName, expected, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static bool ProcessExists(uint pid)
    {
        try
        {
            using (Process process = Process.GetProcessById((int)pid))
                return !process.HasExited;
        }
        catch
        {
            return false;
        }
    }

    private static void ThrowForHr(int hr, string operation)
    {
        if (hr >= 0)
            return;

        Exception inner = Marshal.GetExceptionForHR(hr);
        string detail = inner == null ? "HRESULT 0x" + hr.ToString("X8") : inner.Message;
        throw new COMException(operation + " failed: " + detail, hr);
    }
}
'@
}


switch ($Action) {
    'Launch' {
        $frame = [SettingsFrameLauncher]::Launch($TimeoutMilliseconds)
        [pscustomobject]@{
            AppPid      = $frame.AppPid
            FramePid    = $frame.FramePid
            FrameHwnd   = $frame.FrameHwndHex
        } | ConvertTo-Json -Compress
    }

    'Close' {
        if ([string]::IsNullOrWhiteSpace($Hwnd)) {
            throw '-Hwnd is required for -Action Close.'
        }
        if ($FramePid -eq 0) {
            throw '-FramePid is required for -Action Close.'
        }
        if ($AppPid -eq 0) {
            throw '-AppPid is required for -Action Close.'
        }

        $status = [SettingsFrameLauncher]::CloseFrameHex(
            $Hwnd,
            $FramePid,
            $AppPid,
            $TimeoutMilliseconds
        )
        [pscustomobject]@{
            Status    = $status
            FramePid  = $FramePid
            AppPid    = $AppPid
            FrameHwnd = $Hwnd
        } | ConvertTo-Json -Compress
    }
}
