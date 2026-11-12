param(
    [Parameter(Mandatory = $true)][string]$StatePath,
    [Parameter(Mandatory = $true)][string]$Title
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName PresentationFramework

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

# Why: whenever the controls window is activated, the holder takes activation back, so each action starts inactive.
[xml]$holderXaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        Title="$Title holder" Width="200" Height="120" ShowActivated="False" WindowStartupLocation="Manual" Left="480" Top="40" />
"@

$window = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$holder = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $holderXaml))
$items = $window.FindName("Items")
$branch = $window.FindName("Branch")
$level = $window.FindName("Level")
for ($i = 0; $i -lt 200; $i++) { [void]$items.Items.Add("Semantic item $i") }

$state = [ordered]@{ ready = $false; activations = 0; active = $false; listOffset = 0.0; listViewport = 0.0; branchExpanded = $false; level = 10.0 }
function Save-FixtureState {
    # Why: an exception in a WPF event handler would end the fixture; a reader holding the file only delays one write.
    try {
        $temporary = "$StatePath.tmp"
        ($state | ConvertTo-Json -Compress) | Set-Content -LiteralPath $temporary -Encoding UTF8
        Move-Item -LiteralPath $temporary -Destination $StatePath -Force
    } catch {}
}

$window.Add_Activated({
    $state.activations++
    $state.active = $true
    Save-FixtureState
    [void]$window.Dispatcher.BeginInvoke([Action]{ [void]$holder.Activate() })
})
$window.Add_Deactivated({ $state.active = $false; Save-FixtureState })
$items.AddHandler([Windows.Controls.ScrollViewer]::ScrollChangedEvent, [Windows.Controls.ScrollChangedEventHandler]{
    param($source, $change)
    $state.listOffset = $change.VerticalOffset
    $state.listViewport = $change.ViewportHeight
    Save-FixtureState
})
$branch.Add_Expanded({ $state.branchExpanded = $true; Save-FixtureState })
$branch.Add_Collapsed({ $state.branchExpanded = $false; Save-FixtureState })
$level.Add_ValueChanged({ $state.level = $level.Value; Save-FixtureState })
$window.Add_ContentRendered({
    # Why: an owned holder never becomes the process's MainWindowHandle, so pid targeting still finds the controls window.
    $holder.Owner = $window
    $holder.Show()
    $state.ready = $true
    Save-FixtureState
})

# Why: ShowDialog always activates; Application.Run shows the window with ShowActivated honored.
[void](New-Object Windows.Application).Run($window)
