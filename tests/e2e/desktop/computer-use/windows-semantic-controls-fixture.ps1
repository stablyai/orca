param(
    [Parameter(Mandatory = $true)][string]$StatePath,
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$HolderTitle
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName PresentationFramework
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
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

# Why: ShowActivated=False opens the window behind the foreground one, so any activation by an action is observable.
[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        Title="$Title" Width="420" Height="520" ShowActivated="False" WindowStartupLocation="Manual" Left="40" Top="40">
  <StackPanel Margin="8">
    <ListBox Name="Items" Height="160" ScrollViewer.CanContentScroll="True" AutomationProperties.Name="Semantic items">
      <ListBox.ItemsPanel>
        <ItemsPanelTemplate><StackPanel /></ItemsPanelTemplate>
      </ListBox.ItemsPanel>
    </ListBox>
    <TreeView Name="Tree" Height="120" AutomationProperties.Name="Semantic tree">
      <TreeViewItem Name="Branch" Header="Semantic branch">
        <TreeViewItem Header="Semantic leaf one" />
        <TreeViewItem Header="Semantic leaf two" />
      </TreeViewItem>
    </TreeView>
    <Slider Name="Level" Minimum="0" Maximum="100" Value="10" AutomationProperties.Name="Semantic level" />
  </StackPanel>
</Window>
"@

$window = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$items = $window.FindName("Items")
$branch = $window.FindName("Branch")
$level = $window.FindName("Level")
for ($i = 0; $i -lt 200; $i++) { [void]$items.Items.Add("Semantic item $i") }

$state = [ordered]@{ ready = $false; activations = 0; active = $false; listOffset = 0.0; listViewport = 0.0; branchExpanded = $false; level = 10.0; events = @() }
# Why: a failed activation check prints this log, which says what ran just before the window was activated.
$clock = [Diagnostics.Stopwatch]::StartNew()
function Add-FixtureEvent([string]$Name) {
    $state.events = @($state.events + "$($clock.ElapsedMilliseconds) $Name fg=$([OrcaFixtureForeground]::Title())" | Select-Object -Last 40)
}
function Save-FixtureState {
    # Why: an exception in a WPF event handler would end the fixture; a reader holding the file only delays one write.
    try {
        $temporary = "$StatePath.tmp"
        ($state | ConvertTo-Json -Compress) | Set-Content -LiteralPath $temporary -Encoding UTF8
        Move-Item -LiteralPath $temporary -Destination $StatePath -Force
    } catch {}
}

# Why: hand activation back to the holder process later, so each action starts behind another app and Orca still sees what it caused.
$handBack = New-Object Windows.Threading.DispatcherTimer
$handBack.Interval = [TimeSpan]::FromSeconds(2)
$handBack.Add_Tick({ $handBack.Stop(); Add-FixtureEvent "hand back $([OrcaFixtureForeground]::Give($HolderTitle))"; Save-FixtureState })
$window.Add_Activated({
    $state.activations++
    $state.active = $true
    Add-FixtureEvent "activated"
    Save-FixtureState
    $handBack.Stop()
    $handBack.Start()
})
$window.Add_Deactivated({ $state.active = $false; Add-FixtureEvent "deactivated"; Save-FixtureState })
$items.AddHandler([Windows.Controls.ScrollViewer]::ScrollChangedEvent, [Windows.Controls.ScrollChangedEventHandler]{
    param($source, $change)
    $state.listOffset = $change.VerticalOffset
    $state.listViewport = $change.ViewportHeight
    Add-FixtureEvent "scrolled $($change.VerticalOffset)"
    Save-FixtureState
})
$branch.Add_Expanded({ $state.branchExpanded = $true; Add-FixtureEvent "expanded"; Save-FixtureState })
$branch.Add_Collapsed({ $state.branchExpanded = $false; Add-FixtureEvent "collapsed"; Save-FixtureState })
$level.Add_ValueChanged({ $state.level = $level.Value; Add-FixtureEvent "level $($level.Value)"; Save-FixtureState })
$window.Add_ContentRendered({ $state.ready = $true; Save-FixtureState })

# Why: ShowDialog always activates; Application.Run shows the window with ShowActivated honored.
[void](New-Object Windows.Application).Run($window)
