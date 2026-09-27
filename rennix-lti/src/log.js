// Minimal structured-enough logging -- a timestamp + level prefix on top of
// plain console output, so this is grep-able in whatever log aggregator ends
// up in front of stdout, without pulling in a logging library for a project
// that's deliberately kept dependency-light.
function line(level, args) {
  return [`[${new Date().toISOString()}]`, `[${level}]`, ...args];
}

function warn(...args) {
  console.warn(...line('warn', args));
}

function error(...args) {
  console.error(...line('error', args));
}

function info(...args) {
  console.log(...line('info', args));
}

module.exports = { warn, error, info };
