param([string]$TextPath, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
$speaker = New-Object -ComObject SAPI.SpVoice
$englishVoice = @($speaker.GetVoices()) | Where-Object { $_.GetAttribute('Language') -match '^409' } | Select-Object -First 1
if (-not $englishVoice) { throw 'An English Windows speech voice is required to regenerate the original speech fixtures.' }
$speaker.Voice = $englishVoice
$speaker.Rate = -1
$speechStream = New-Object -ComObject SAPI.SpFileStream
$speechStream.Open($OutputPath, 3)
$speaker.AudioOutputStream = $speechStream
$null = $speaker.Speak([System.IO.File]::ReadAllText($TextPath))
$speechStream.Close()
