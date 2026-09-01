Option Explicit

Function QuoteArgument(value)
  If InStr(value, Chr(34)) > 0 Or InStr(value, vbCr) > 0 Or InStr(value, vbLf) > 0 Then
    Err.Raise vbObjectError + 1, "real-orca-detached-launcher", "Invalid argument"
  End If
  QuoteArgument = Chr(34) & value & Chr(34)
End Function

Dim args, command, index, shell, status
Set args = WScript.Arguments
If args.Count = 0 Then
  Err.Raise vbObjectError + 2, "real-orca-detached-launcher", "Missing executable"
End If

command = ""
For index = 0 To args.Count - 1
  If Len(command) > 0 Then command = command & " "
  command = command & QuoteArgument(CStr(args(index)))
Next

Set shell = CreateObject("WScript.Shell")
status = shell.Run(command, 0, False)
If status <> 0 Then WScript.Quit status
