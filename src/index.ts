import { spawn, spawnSync } from "child_process";

export interface SpawnBurstOptions {
  /** A shell command line to run. Make sure you quote arguments properly! */
  cmd: string;
  /** A file where the cached output will be stored. Also plays the role of a
   * "global mutex". */
  cacheFile: string;
  /** If the cache was updated less than this number of seconds ago, the command
   * is not even run. */
  cacheMaxAgeSec: number;
  /** A regexp which makes the tool fail (or re-run the command) if the output
   * doesn't match the expectation. */
  validator: string;
}

/**
 * Runs a shell command and returns its stdout with singleton-like caching.
 */
export function spawnBurstSync(options: SpawnBurstOptions): string {
  try {
    const cmdLine = buildCmdLine(options);
    const result = spawnSync(cmdLine[0], cmdLine.slice(1), {
      stdio: [undefined, "pipe", "pipe"],
    });
    return processResult("spawnBurstSync", result);
  } catch (error: any) {
    processError("spawnBurstSync", error, options);
  }
}

/**
 * An async version of spawnBurstSync(). Suitable when we need to call it to
 * e.g. hot-reload some config changes while the app is running.
 */
export async function spawnBurst(options: SpawnBurstOptions): Promise<string> {
  try {
    const cmdLine = buildCmdLine(options);
    const result = await new Promise<Result>((resolve) => {
      const child = spawn(cmdLine[0], cmdLine.slice(1), {
        stdio: [undefined, "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("close", () =>
        resolve({
          status: child.exitCode,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        })
      );
      child.on("error", () =>
        resolve({
          status: child.exitCode,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        })
      );
    });
    return processResult("spawnBurst", result);
  } catch (error: any) {
    processError("spawnBurst", error, options);
  }
}

interface Result {
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

function processResult(func: string, res: Result): string {
  if (res.status !== 0) {
    const stderr = res.stderr.toString().trim();
    throw Error(
      `${func}() failed with status ${res.status}: ` +
        (stderr || "<empty stderr>")
    );
  }

  return res.stdout.toString();
}

function processError(
  func: string,
  error: any,
  options: SpawnBurstOptions
): never {
  if (typeof error?.stack === "string") {
    error.stack =
      error.stack.trimEnd() +
      `\nin ${func}(${JSON.stringify(Object.values(options))})`;
  }

  throw error;
}

/**
 * Q: Why Perl in 2022+?
 *
 * A: There are really not much options unfortunately.
 *
 * - Node doesn't have flock (and fs-ext module is super-fragile, it randomly
 *   corrupts on "npm install" runs, and the author can't reproduce).
 * - Python is... python... you never know whether you have python pointing to
 *   python2 or to python3 or no python at all.
 * - Bash doesn't have flock in MacOS.
 * - We could've built a C Node extension, but it would be even worse than Perl.
 * - At the same time, Perl is always perl5, it exists everywhere, because it
 *   got stuck in time.
 */
function buildCmdLine({
  cmd,
  cacheFile,
  cacheMaxAgeSec,
  validator,
}: SpawnBurstOptions): string[] {
  return [
    "perl",
    "-we",
    String.raw`
      use Fcntl qw(:flock :seek);
      use File::stat;

      my ($cmd, $cacheFile, $cacheMaxAgeSec, $validator) = @ARGV;
      $validator = qr/$validator/s;

      # Remember who last wrote the cache before becoming a singleton.
      my ($oldWriter) = readCache($cacheFile);

      # Become the only process running on this machine (singleton).
      # Only one process will acquire the lock, others will wait.
      my $singletonFile = $cacheFile . ".lock";
      open(my $singleton, ">>", $singletonFile) or die("open $singletonFile: $!\n");
      flock($singleton, LOCK_EX) or die("flock LOCK_EX: $!\n");

      # Re-read the cache after we became a singleton.
      my ($writer, $data, $age) = readCache($cacheFile);

      # If the cache was updated not too long time ago after the last burst,
      # return it (i.e. allow some staleness if requested).
      if ($data ne "" && $data =~ $validator && $cacheMaxAgeSec > 0 && $age < $cacheMaxAgeSec) {
        print $data;
        exit(0);
      }

      # If no-one else has changed the cache during our singleton
      # acquisition wait period, run the command and write the cache.
      if ($data eq "" || $data !~ $validator || $writer eq $oldWriter) {
        $data = qx{$cmd};
        die("command exited with nonzero status $?\n") if $? != 0;
        die("response is not valid: $data\n") if $data !~ $validator;
        writeCache($cacheFile, $data);
      }

      print $data;

      # Reads the cache file with proper locking.
      # Returns a triple: ($writer, $data, $age).
      sub readCache {
        my ($file) = @_;
        open(my $fh, "+>>", $file) or die("open read $file: $!\n");
        flock($fh, LOCK_SH) or die("flock $file LOCK_SH: $!\n");
        seek($fh, 0, SEEK_SET) or die("seek $file: $!\n");
        local $/;
        my $content = <$fh>;
        $content eq "" and return ("", "", 0);
        my ($writer, $data) = $content =~ /^([^\n]+)\n(.*)$/s or die("invalid format of $file\n");
        my $age = time() - stat($fh)->mtime;
        close($fh);
        return ($writer, $data, $age);
      }

      # Writes the cache file with proper locking.
      # The file content is prepended with the current pid.
      sub writeCache {
        my ($file, $data) = @_;
        open(my $fh, "+>>", $file) or die("open write $file: $!\n");
        chmod(0600, $file) or die("chmod $file: $!\n");
        flock($fh, LOCK_EX) or die("flock $file LOCK_EX: $!\n");
        seek($fh, 0, SEEK_SET) or die("seek $file: $!\n");
        truncate($fh, 0) or die("truncate $file: $!\n");
        print $fh "$$: " . scalar(localtime) . "\n$data";
        close($fh);
      }
    `
      .replace(/^ {6}/g, "")
      .trim(),
    cmd,
    cacheFile,
    cacheMaxAgeSec.toString(),
    validator,
  ];
}
