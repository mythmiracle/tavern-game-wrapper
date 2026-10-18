// Export embedded sources before editing; sync embeds them and updates the launcher fallback.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.resolve(__dirname, '..');
const bridgePath = path.join(root, 'neutralino-storage-bridge.js');
const mappings = { csharpSource: ['NeuSqliteExtension.cs', '\r\n'], pythonSource: ['main.py', '\n'], cmdLauncher: ['run-extension.cmd', '\r\n'], shLauncher: ['run-extension.sh', '\n'] };
function getSources(text = fs.readFileSync(bridgePath, 'utf8')) {
  const start = text.indexOf('  function getSqliteExtensionSources()');
  const end = text.indexOf('  function parseNeutralinoGlobalsFromSource', start);
  return vm.runInNewContext(`(${text.slice(start, end).trim()})()`, {});
}
function synchronize() {
  let bridge = fs.readFileSync(bridgePath, 'utf8');
  const csharpPath = path.join(root, 'extensions/sqlite/NeuSqliteExtension.cs');
  let cs = fs.readFileSync(csharpPath, 'utf8').split('// BEGIN CHUNK STORE')[0].trimEnd();
  cs += '\n\n// BEGIN CHUNK STORE\n' + fs.readFileSync(path.join(root, 'storage-chunk-backend.cs'), 'utf8');
  fs.writeFileSync(csharpPath, cs);
  const pythonPath = path.join(root, 'extensions/sqlite/main.py');
  let py = fs.readFileSync(pythonPath, 'utf8');
  const begin = py.indexOf('# BEGIN CHUNK STORE');
  if (begin >= 0) py = py.slice(0, begin) + py.slice(py.indexOf('# END CHUNK STORE', begin) + '# END CHUNK STORE'.length).replace(/^\r?\n/, '');
  const mixin = fs.readFileSync(path.join(root, 'storage-chunk-backend.py'), 'utf8');
  py = py.replace(/class SqliteDeltaStore(?:\(ChunkStoreMixin\))?:/, '# BEGIN CHUNK STORE\n' + mixin + '\n# END CHUNK STORE\nclass SqliteDeltaStore(ChunkStoreMixin):');
  fs.writeFileSync(pythonPath, py);
  const codec = fs.readFileSync(path.join(root, 'storage-chunks.js'), 'utf8').split("if (typeof module")[0].trim() + '\n' + fs.readFileSync(path.join(root, 'storage-chunk-worker.js'), 'utf8').split("if (typeof module")[0].trim();
  const oldStart = bridge.indexOf('  // BEGIN CHUNK CODEC');
  if (oldStart >= 0) bridge = bridge.slice(0, oldStart).trimEnd() + '\n\n' + bridge.slice(bridge.indexOf('  const BRIDGE_VERSION', oldStart));
  bridge = bridge.replace('  const BRIDGE_VERSION', '  // BEGIN CHUNK CODEC\n' + codec + '\n  // END CHUNK CODEC\n\n  const BRIDGE_VERSION');
  for (const [name, [file, newline]] of Object.entries(mappings)) {
    const text = fs.readFileSync(path.join(root, 'extensions/sqlite', file), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trimEnd();
    const lines = text.split('\n').map(line => `      '${line.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}',`);
    const start = bridge.indexOf(`    const ${name} = [`);
    const end = bridge.indexOf("].join(", start);
    const tail = bridge.indexOf(';', end) + 1;
    bridge = bridge.slice(0, start) + `    const ${name} = [\n${lines.join('\n')}\n    ].join(${JSON.stringify(newline)});` + bridge.slice(tail);
  }
  fs.writeFileSync(bridgePath, bridge);
  const launcherPath = path.join(root, 'launcher.html');
  let launcher = fs.readFileSync(launcherPath, 'utf8');
  const script = launcher.indexOf('(function initNeutralinoStorageBridgeV9(');
  const start = launcher.lastIndexOf('/**', script);
  const end = launcher.indexOf('</script>', script);
  launcher = launcher.slice(0, start) + bridge.trimEnd() + '\n  ' + launcher.slice(end);
  const version = bridge.match(/const BRIDGE_VERSION = (\d+)/)[1];
  launcher = launcher.replace(/neutralino-storage-bridge\.js\?v=\d+/g, 'neutralino-storage-bridge.js?v=' + version);
  fs.writeFileSync(launcherPath, launcher);
}
if (require.main === module) {
  if (process.argv[2] === 'export') {
    fs.mkdirSync(path.join(root, 'extensions/sqlite'), { recursive: true });
    const sources = getSources();
    for (const [name, [file]] of Object.entries(mappings)) fs.writeFileSync(path.join(root, 'extensions/sqlite', file), sources[name]);
  } else if (process.argv[2] === 'sync') synchronize();
  else throw new Error('Usage: node scripts/storage-sources.cjs export|sync');
}
module.exports = { getSources, synchronize };
