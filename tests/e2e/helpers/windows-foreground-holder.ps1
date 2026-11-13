param([Parameter(Mandatory = $true)][string]$Title)

$ErrorActionPreference = "Stop"
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

// Stands in for the user's own app: holds the foreground and answers one stdin command per line.
public static class OrcaForegroundHolder {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int processId);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool enable);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern short VkKeyScan(char ch);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    const int ASFW_ANY = -1;
    const uint KEYEVENTF_KEYUP = 2;
    static readonly ConcurrentQueue<string> commands = new ConcurrentQueue<string>();
    static Form form;

    public static void Run(string title) {
        form = new Form();
        form.Text = title;
        form.StartPosition = FormStartPosition.Manual;
        form.SetBounds(0, 0, 320, 160);
        Thread reader = new Thread(ReadCommands);
        reader.IsBackground = true;
        // Why: commands run on the window's own thread, which is the one Windows lets activate it.
        System.Windows.Forms.Timer pump = new System.Windows.Forms.Timer();
        pump.Interval = 20;
        pump.Tick += delegate {
            string command;
            while (commands.TryDequeue(out command)) {
                Handle(command);
            }
        };
        form.Shown += delegate {
            reader.Start();
            pump.Start();
            Reply("ready");
        };
        Application.Run(form);
    }

    static void ReadCommands() {
        string line;
        while ((line = Console.In.ReadLine()) != null) {
            commands.Enqueue(line);
        }
        commands.Enqueue("exit");
    }

    static void Handle(string command) {
        if (command == "exit") {
            Application.Exit();
        } else if (command == "take") {
            Reply(Take() ? "ok" : "error " + Describe());
        } else if (command == "foreground") {
            Reply(Describe());
        } else if (command.StartsWith("key ") && command.Length == 5) {
            Press(command[4]);
            Reply("ok");
        } else {
            Reply("error unknown command " + command);
        }
    }

    static string Describe() {
        IntPtr foreground = GetForegroundWindow();
        uint processId;
        GetWindowThreadProcessId(foreground, out processId);
        StringBuilder title = new StringBuilder(256);
        GetWindowText(foreground, title, title.Capacity);
        return (foreground == form.Handle ? "holder " : "other ") + processId + " " + title;
    }

    static bool Take() {
        IntPtr foreground = GetForegroundWindow();
        if (foreground != form.Handle) {
            uint ignored;
            uint foregroundThread = GetWindowThreadProcessId(foreground, out ignored);
            uint self = GetCurrentThreadId();
            bool attached = foregroundThread != 0 && foregroundThread != self && AttachThreadInput(self, foregroundThread, true);
            BringWindowToTop(form.Handle);
            SetForegroundWindow(form.Handle);
            if (attached) {
                AttachThreadInput(self, foregroundThread, false);
            }
        }
        // Why: lifts the foreground lock, so any activation Orca attempts succeeds and the test sees it.
        AllowSetForegroundWindow(ASFW_ANY);
        return GetForegroundWindow() == form.Handle;
    }

    static void Press(char key) {
        byte virtualKey = (byte)(VkKeyScan(key) & 0xff);
        keybd_event(virtualKey, 0, 0, UIntPtr.Zero);
        keybd_event(virtualKey, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    static void Reply(string text) {
        Console.Out.WriteLine(text);
        Console.Out.Flush();
    }
}
'@

[OrcaForegroundHolder]::Run($Title)
