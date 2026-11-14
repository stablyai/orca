param(
    [Parameter(Mandatory = $true)][string]$StatePath,
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$HolderTitle
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
// Why: a form shown without activation opens behind the foreground window, so any activation by an action is observable.
public class OrcaFixtureInactiveForm : System.Windows.Forms.Form {
    protected override bool ShowWithoutActivation { get { return true; } }
}
public static class OrcaFixtureForeground {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string className, string title);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    public static bool Give(string title) { return SetForegroundWindow(FindWindow(null, title)); }
    public static string Title() {
        var text = new StringBuilder(256);
        GetWindowText(GetForegroundWindow(), text, text.Capacity);
        return text.ToString();
    }
}
"@

$form = New-Object OrcaFixtureInactiveForm
$form.Text = $Title
$form.StartPosition = "Manual"
$form.Bounds = New-Object System.Drawing.Rectangle(480, 40, 420, 320)

$name = New-Object System.Windows.Forms.TextBox
$name.Bounds = New-Object System.Drawing.Rectangle(12, 12, 380, 24)
$name.Text = "seed-name"
$notes = New-Object System.Windows.Forms.TextBox
$notes.Multiline = $true
$notes.Bounds = New-Object System.Drawing.Rectangle(12, 48, 380, 120)
$notes.Text = "seed-notes"
$form.Controls.AddRange(@($name, $notes))
# Why: put each caret at the end, so typed text lands after the seed wherever the field's caret starts.
$name.Select($name.Text.Length, 0)
$notes.Select($notes.Text.Length, 0)

$state = [ordered]@{ ready = $false; activations = 0; active = $false; name = $name.Text; notes = $notes.Text; events = @() }
# Why: a failed activation check prints this log, which says what ran just before the window was activated.
$clock = [Diagnostics.Stopwatch]::StartNew()
function Add-FixtureEvent([string]$Name) {
    $state.events = @($state.events + "$($clock.ElapsedMilliseconds) $Name fg=$([OrcaFixtureForeground]::Title())" | Select-Object -Last 40)
}
function Save-FixtureState {
    # Why: an exception in an event handler would end the fixture; a reader holding the file only delays one write.
    try {
        $temporary = "$StatePath.tmp"
        ($state | ConvertTo-Json -Compress) | Set-Content -LiteralPath $temporary -Encoding UTF8
        Move-Item -LiteralPath $temporary -Destination $StatePath -Force
    } catch {}
}

# Why: hand activation back to the holder process later, so each action starts behind another app and Orca still sees what it caused.
$handBack = New-Object System.Windows.Forms.Timer
$handBack.Interval = 2000
$handBack.Add_Tick({ $handBack.Stop(); Add-FixtureEvent "hand back $([OrcaFixtureForeground]::Give($HolderTitle))"; Save-FixtureState })
$form.Add_Activated({
    $state.activations++
    $state.active = $true
    Add-FixtureEvent "activated"
    Save-FixtureState
    $handBack.Stop()
    $handBack.Start()
})
$form.Add_Deactivate({ $state.active = $false; Add-FixtureEvent "deactivated"; Save-FixtureState })
$name.Add_TextChanged({ $state.name = $name.Text; Add-FixtureEvent "name changed"; Save-FixtureState })
$notes.Add_TextChanged({ $state.notes = $notes.Text; Add-FixtureEvent "notes changed"; Save-FixtureState })
$form.Add_Shown({ $form.Refresh(); $state.ready = $true; Save-FixtureState })

[System.Windows.Forms.Application]::Run($form)
