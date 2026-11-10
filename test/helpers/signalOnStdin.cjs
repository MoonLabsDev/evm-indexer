// Test-only preload (node -r) for the spawned CLI: Windows cannot deliver SIGTERM/SIGINT to a child
// process (child.kill terminates it at once), so a line "SIGTERM" or "SIGINT" on stdin raises that
// signal inside the process, which runs the CLI's real signal handlers.
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (const line of chunk.split(/\r?\n/)) {
    const sig = line.trim();
    if (sig === 'SIGTERM' || sig === 'SIGINT') process.emit(sig, sig);
  }
});
