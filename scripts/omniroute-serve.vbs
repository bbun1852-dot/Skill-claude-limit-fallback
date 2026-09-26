' Starts the OmniRoute server hidden (launched via explorer.exe so it outlives this session).
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Program Files\nodejs\node.exe"" """ & sh.ExpandEnvironmentStrings("%APPDATA%") & "\npm\node_modules\omniroute\bin\omniroute.mjs"" serve", 0, False
