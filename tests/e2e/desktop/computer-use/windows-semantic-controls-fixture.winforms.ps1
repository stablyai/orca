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
$form.Bounds = New-Object System.Drawing.Rectangle(480, 40, 420, 340)

$name = New-Object System.Windows.Forms.TextBox
$name.Bounds = New-Object System.Drawing.Rectangle(12, 12, 380, 24)
$name.Text = "seed-name"
$notes = New-Object System.Windows.Forms.TextBox
$notes.Multiline = $true
$notes.Bounds = New-Object System.Drawing.Rectangle(12, 48, 380, 120)
$notes.Text = "seed-notes"
$form.Controls.AddRange(@($name, $notes))
$press = New-Object System.Windows.Forms.Button
$press.Text = "Semantic press"
$press.Bounds = New-Object System.Drawing.Rectangle(12, 176, 120, 28)
$check = New-Object System.Windows.Forms.CheckBox
$check.Text = "Semantic check"
$check.Bounds = New-Object System.Drawing.Rectangle(144, 176, 140, 28)
$combo = New-Object System.Windows.Forms.ComboBox
$combo.DropDownStyle = "DropDownList"
$combo.Bounds = New-Object System.Drawing.Rectangle(12, 212, 180, 24)
[void]$combo.Items.AddRange(@("Alpha", "Beta", "Gamma"))
$combo.SelectedIndex = 0
$list = New-Object System.Windows.Forms.ListBox
$list.Bounds = New-Object System.Drawing.Rectangle(204, 212, 188, 60)
for ($i = 0; $i -lt 100; $i++) { [void]$list.Items.Add("Row $i") }
$form.Controls.AddRange(@($press, $check, $combo, $list))
# Why: put each caret at the end, so typed text lands after the seed wherever the field's caret starts.
$name.Select($name.Text.Length, 0)
$notes.Select($notes.Text.Length, 0)

$state = [ordered]@{ ready = $false; activations = 0; active = $false; name = $name.Text; notes = $notes.Text; presses = 0; checked = $false; combo = "Alpha"; listTop = 0; events = @() }
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
$press.Add_Click({ $state.presses++; Add-FixtureEvent "pressed"; Save-FixtureState })
$check.Add_CheckedChanged({ $state.checked = $check.Checked; Add-FixtureEvent "checked"; Save-FixtureState })
$combo.Add_SelectedIndexChanged({ $state.combo = [string]$combo.SelectedItem; Add-FixtureEvent "combo"; Save-FixtureState })
# Why: a list box raises no event when it scrolls, so its top row is polled.
$poll = New-Object System.Windows.Forms.Timer
$poll.Interval = 100
$poll.Add_Tick({ if ($list.TopIndex -ne $state.listTop) { $state.listTop = $list.TopIndex; Add-FixtureEvent "list top"; Save-FixtureState } })
$poll.Start()
$form.Add_Shown({ $form.Refresh(); $state.ready = $true; Save-FixtureState })

[System.Windows.Forms.Application]::Run($form)
