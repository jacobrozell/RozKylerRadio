<#
.SYNOPSIS
  Build playlist.json for Renders Radio from your consolidated Renders pool or in-project Renders folders.

.PARAMETER ScanRoot
  Folder to recurse. Default: E:\...\Music_Archives\Renders if that folder exists, else the RozKyler project folder (in-project \Renders\ scan).

.PARAMETER HttpRoot
  HTTP document root for URL paths in playlist.json (default: Music_Archives, three levels above this script).

.PARAMETER OutFile
  Output JSON path (default: radio/playlist.json next to this script).

.PARAMETER Extensions
  File extensions to include (default: .mp3 .wav .flac .m4a .ogg). Example for GitHub Pages: -Extensions .mp3

.EXAMPLE
  cd E:\Music_Archives\Projects\RozKyler\radio
  .\build-playlist.ps1

  From E:\Music_Archives: npx --yes serve
  Open http://localhost:3000/Projects/RozKyler/radio/

.EXAMPLE
  GitHub Pages: copy Renders/ and radio/ to the repo root (or gh-pages branch), then:
  .\build-playlist.ps1 -ScanRoot .\Renders -HttpRoot . -OutFile .\radio\playlist.json
#>
param(
  [string] $ScanRoot = "",
  [string] $HttpRoot = "",
  [string] $OutFile = (Join-Path $PSScriptRoot "playlist.json"),
  [string[]] $Extensions = @(".mp3", ".wav", ".flac", ".m4a", ".ogg")
)

$ErrorActionPreference = "Stop"

$musicRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$defaultRendersPool = Join-Path $musicRoot "Renders"

if (-not $ScanRoot) {
  if (Test-Path -LiteralPath $defaultRendersPool) {
    $ScanRoot = $defaultRendersPool
  }
  else {
    $ScanRoot = Split-Path -Parent $PSScriptRoot
  }
}

$scan = Resolve-Path $ScanRoot

if (-not $HttpRoot) {
  $HttpRoot = $musicRoot
}

$root = (Resolve-Path $HttpRoot).Path.TrimEnd("\")

$rendersPoolPath = ""
if (Test-Path -LiteralPath $defaultRendersPool) {
  $rendersPoolPath = (Resolve-Path $defaultRendersPool).Path.TrimEnd("\")
}
$scanNorm = $scan.Path.TrimEnd("\")
$useWideScan =
  -not [string]::IsNullOrEmpty($rendersPoolPath) -and (
    ($scanNorm -eq $rendersPoolPath) -or
    $scanNorm.StartsWith(
      $rendersPoolPath + [System.IO.Path]::DirectorySeparatorChar,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  )

function Get-UrlPathRelativeToRoot {
  param([string] $FilePath, [string] $RootDir)
  $rootUri = New-Object Uri ((New-Object Uri ($RootDir + [char]0x5c)).AbsoluteUri)
  $fileUri = New-Object Uri ((New-Object Uri $FilePath).AbsoluteUri)
  $rel = $rootUri.MakeRelativeUri($fileUri).ToString()
  if ($rel.StartsWith("..")) {
    throw "File is outside HttpRoot: $FilePath. Set -HttpRoot to a parent folder."
  }
  [Uri]::UnescapeDataString($rel) -replace '\\', '/'
}

$ext = foreach ($e in $Extensions) {
  $x = $e.Trim().ToLowerInvariant()
  if (-not $x.StartsWith(".")) { $x = "." + $x }
  $x
}
$allFiles = Get-ChildItem -LiteralPath $scan.Path -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $ext -contains $_.Extension.ToLowerInvariant() }

# Consolidated pool under Music_Archives\Renders: include all audio under the scan tree.
# Else (in-project scan): only files under a path segment named Renders.
if ($useWideScan) {
  $files = $allFiles | Sort-Object FullName
}
else {
  $files = $allFiles | Where-Object { $_.FullName -match '[\\/]Renders[\\/]' } | Sort-Object FullName
}

$tracks = foreach ($f in $files) {
  $url = Get-UrlPathRelativeToRoot -FilePath $f.FullName -RootDir $root
  [ordered]@{
    title = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
    src   = $url
  }
}

$obj = [ordered]@{
  generated = (Get-Date).ToString("o")
  count     = $tracks.Count
  tracks    = @($tracks)
}

$json = $obj | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($OutFile, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "Wrote $($tracks.Count) tracks to $OutFile"
Write-Host "ScanRoot: $($scan.Path)"
Write-Host "HttpRoot (serve from): $root"
Write-Host "Local preview: /Projects/RozKyler/radio/ when served from Music_Archives"
