param([switch]$Http)
$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $repoPath
try {
    New-Item -ItemType Directory -Force -Path '.tmp/save-recovery' | Out-Null
    node scripts/storage-sources.cjs export
    if ($LASTEXITCODE -ne 0) { throw 'Source export failed' }
    $compilerPath = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    if (-not (Test-Path -LiteralPath $compilerPath)) { $compilerPath = Join-Path $env:SystemRoot 'Microsoft.NET/Framework/v4.0.30319/csc.exe' }
    & $compilerPath /nologo /target:exe /optimize+ /r:System.dll /r:System.Web.Extensions.dll /main:StorageBackendRunner /out:.tmp\save-recovery\backend-runner.exe extensions\sqlite\NeuSqliteExtension.cs tests\StorageBackendRunner.cs
    if ($LASTEXITCODE -ne 0) { throw 'C# test backend compilation failed' }
    node --check neutralino-storage-bridge.js
    if ($LASTEXITCODE -ne 0) { throw 'JavaScript syntax check failed' }
    node tests/service-worker-policy.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Desktop service worker policy tests failed' }
    node tests/storage-hooks.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Storage hook compatibility tests failed' }
    node tests/window-close.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Native close event tests failed' }
    node tests/autosave-coalescing.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Game autosave coalescing tests failed' }
    node tests/browser-storage-restore.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Browser storage restore tests failed' }
    node tests/storage-recovery.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Bridge tests failed' }
    node tests/chunk-vectors.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Shared vectors failed' }
    node tests/storage-chunks.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Chunk storage tests failed' }
    node tests/chunk-worker.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Worker tests failed' }
    node tests/chunk-queue.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Queue tests failed' }
    python tests/storage_backend_test.py -v
    if ($LASTEXITCODE -ne 0) { throw 'Python backend tests failed' }
    if ($Http) {
        & $compilerPath /nologo /target:winexe /optimize+ /r:System.dll /r:System.Web.Extensions.dll /out:extensions\sqlite\neu-sqlite-ext.exe extensions\sqlite\NeuSqliteExtension.cs
        if ($LASTEXITCODE -ne 0) { throw 'HTTP backend compilation failed' }
        python tests/storage_http_test.py
        if ($LASTEXITCODE -ne 0) { throw 'HTTP integration test failed' }
    }
} finally { Pop-Location }
