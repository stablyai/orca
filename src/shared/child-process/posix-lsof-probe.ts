// Mirrors process-tree-termination: unreaped zombies cannot keep probe work running.
export const RELAY_LSOF_PROBE_JS = String.raw`
var spawn = require('child_process').spawn;
var child;
var census;
var cleanupTimer;
var output = '';
var stderrSeen = false;
var stderrBytes = 0;
var byteCount = 0;
var unavailable = false;
var exited = false;
var closed = false;
var settling = false;
var finished = false;
var originalParent = process.ppid;
var maxBytes = 1024 * 1024;
function groupExists(pid) {
  if (!pid) return false;
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
function finish(unconfirmed) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  clearInterval(ownerTimer);
  clearTimeout(cleanupTimer);
  if (census && census.pid) {
    try { process.kill(-census.pid, 'SIGKILL'); } catch (error) {}
  }
  var lines = output.split('\n');
  if (lines.pop()) unavailable = true;
  var pids = lines.filter(function(line) {
    if (/^[1-9][0-9]*$/.test(line)) return true;
    unavailable = true;
    return false;
  });
  var marker = unconfirmed ? 'cleanup-unconfirmed' : (unavailable || stderrSeen ? 'unavailable' : 'lsof');
  process.stdout.write(marker + '\n' + pids.join('\n') + '\n', function() { process.exit(0); });
}
function readGroupStates(done) {
  var probe;
  try {
    probe = spawn('ps', ['-axo', 'pgid=,state='], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch (error) { return done(null); }
  census = probe;
  var text = '';
  var bytes = 0;
  var failed = false;
  function stop(invalid) {
    failed = failed || invalid;
    if (probe.pid) {
      try { process.kill(-probe.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') failed = true; }
    }
  }
  var timer = setTimeout(function() { stop(true); }, 1000);
  probe.stdout.on('data', function(chunk) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) return stop(true);
    text += chunk.toString('utf8');
  });
  probe.stdout.on('error', function() { stop(true); });
  probe.on('error', function() { stop(true); });
  probe.on('exit', function(code, signal) { stop(code !== 0 || !!signal); });
  probe.on('close', function() {
    clearTimeout(timer);
    if (finished) return;
    if (groupExists(probe.pid)) return finish(true);
    census = null;
    if (failed) return done(null);
    var states = [];
    var lines = text.split('\n');
    if (lines.pop()) return done(null);
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      var match = lines[i].trim().match(/^(\d+)\s+(\S+)$/);
      if (!match) return done(null);
      if (Number(match[1]) === child.pid) states.push(match[2]);
    }
    done(states);
  });
}
function checkCleanup() {
  if (finished) return;
  if (exited && closed) {
    if (!groupExists(child.pid)) return finish(false);
    return readGroupStates(function(states) {
      if (!groupExists(child.pid)) return finish(false);
      if (!states || !states.length) return finish(true);
      if (states.every(function(state) { return state.charAt(0) === 'Z'; })) return finish(false);
      setTimeout(checkCleanup, 25);
    });
  }
  setTimeout(checkCleanup, 25);
}
function cleanup() {
  if (settling) return;
  settling = true;
  clearTimeout(deadline);
  cleanupTimer = setTimeout(function() { finish(true); }, 1500);
  if (child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') return finish(true); }
  }
  checkCleanup();
}
['SIGTERM', 'SIGHUP', 'SIGINT'].forEach(function(signal) {
  process.on(signal, function() { unavailable = true; cleanup(); });
});
child = spawn('lsof', ['-t', '-a', '-U', process.argv[1]], {
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', function(chunk) {
  var remaining = Math.max(0, maxBytes - byteCount);
  byteCount += chunk.length;
  output += chunk.slice(0, remaining).toString('utf8');
  if (byteCount > maxBytes) { unavailable = true; cleanup(); }
});
child.stderr.on('data', function(chunk) {
  if (chunk.toString('utf8').trim()) stderrSeen = true;
  stderrBytes += chunk.length;
  if (stderrBytes > maxBytes) { unavailable = true; cleanup(); }
});
[child.stdout, child.stderr].forEach(function(stream) {
  stream.on('error', function() { unavailable = true; cleanup(); });
});
child.on('error', function() { unavailable = true; exited = true; cleanup(); });
child.on('exit', function(code, signal) {
  exited = true;
  if ((code !== 0 && code !== 1) || signal) unavailable = true;
  cleanup();
});
child.on('close', function() { closed = true; });
var deadline = setTimeout(function() { unavailable = true; cleanup(); }, 5000);
var ownerTimer = setInterval(function() {
  if (process.ppid !== originalParent) { unavailable = true; cleanup(); }
}, 100);
`
