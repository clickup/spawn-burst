# @time-loop/spawn-burst: Spawns a shell command with bursts protection and caching

The main aspects of the tool:

 - The tool supports a synchronous (non-async) call too, so it can be load at a
   Node script boot time to e.g. load some configs synchronously. This is the
   main reason why it wraps a shell command execution: because Node has
   synchronous support for spawning processes.
 - If the command was run less than cacheMaxAgeSec ago, the tool doesn't run it
   and instead returns its previous response.
 - Limits concurrency of the run command to 1 (all other calls in other
   processes will wait).
 - In case there are N concurrent calls pending, the tool runs only 1 command,
   and for all other invokers, it returns its cached output without re-running
   the command. This helps to deal with rate limiting issues of the passed
   command and prevents bursts.
 - Empty stdout is considered as a "no response", so the command would be run
   over and over again. This is related to cases when the locked file was
   semi-written (this may happen on e.g. low free disk space).
 - An exception is thrown if the command's output doesn't match the passed
   validator regexp (in this case, no cache is written as well).

## Example

```
const stdout = await spawnBurstSync({
  cmd: 'sleep 1 && echo "ok $$ $(date -R)"',
  cacheFile: "my-cache-file.cache",
  cacheMaxAgeSec: 2,
  validator: "^ok",
});
```
