# Data directory selection and migration

Settings → General → **Data directory** offers exactly two locations: **Original location** and **Beside the app**. The page displays the resolved paths for both choices. There is no arbitrary path picker. An unavailable or unwritable destination is disabled with its error. Moving is available in the desktop application's own window; a remotely opened web UI cannot initiate it.

## Locations

| Data | Original location | Beside the app |
| --- | --- | --- |
| Magpie configuration, accounts, providers, plugins and application-owned files | `$XDG_CONFIG_HOME/magpie`, otherwise `~/.config/magpie` | `data/` beside the resolved executable |
| Ordinary regenerable caches | `$XDG_CACHE_HOME/magpie`, otherwise `~/.cache/magpie` | `data/cache/` |
| OS cache used for marketplace lists and update staging | `os.UserCacheDir()/magpie` | `data/cache/` when the two original cache paths coincide; otherwise `data/system-cache/` |
| Windows WebView2 profile | WebView2's default `%AppData%/<executable name>` | `data/webview2/` |

On macOS, “beside the app” means beside the application bundle. An AppImage uses the actual AppImage location. Executable links are resolved. Non-Windows system WebView storage remains in its system location and is not migrated. The marketplace and update caches can be regenerated; older portable versions may have kept these in `data/cache`, and those old cache entries remain ordinary cache entries rather than being reclassified.

External agents' homes/configuration, system keychain entries, custom archive locations, autostart registrations and other applications' data are not relocated. Paths inside application-owned configuration are copied as data; selecting a directory does not rewrite external paths.

## Move and restart

1. Selecting the other location opens a confirmation dialog. No migration starts before confirmation.
2. New gateway work is held out while existing requests finish. The operation can be cancelled while waiting for idle. The window stops plugin hosts and MCP processes and waits for their actual exit. A child that cannot be stopped aborts the move before the helper is authorized.
3. A detached helper of the same executable starts without a console window on Windows. Before creating WebView2, the native window joins a private Windows job without breakaway or kill-on-close. Its browser descendants, including processes started during shutdown, inherit that job. Before acknowledging the handoff, the helper opens the named job and validates the window's process creation identity and both processes' job membership. It waits until it is the only remaining member before any source manifest or copy is taken; releasing the browser lock alone is insufficient. Timeout, cancellation, missing proof or inaccessible process/job information aborts the move without copying. No unrelated browser is discovered or terminated. Other still-running descendants of this window can also delay a move. Once no other member remains, the helper enables breakaway for the replacement window, avoiding nested jobs on successive moves. If writers outlive a failed move, a reopened window reuses the strict old job, so retry continues to include those writers. On other platforms the existing application-lease barrier is unchanged. The helper waits for application leases on both locations to end as well. No copying is performed by the live GUI.
4. The helper captures source identities and file manifests, copies into transaction-owned staging directories, and verifies file sizes and SHA-256 hashes. The source is checked again before publishing. Nonempty destinations are renamed to separate dated backups, never merged into the new copy. A failure before the mode switch restores those backups and keeps the source in use.
5. After publishing and verifying the destination again, the helper atomically writes the mode pointer beside the executable. It persists the cleanup state before deleting old data, then removes only files authorized by the original verified manifest. Completion is recorded only after cleanup finishes.
6. The application opens again and displays the result. Copy/verification failures offer retry. A committed move with old files still present displays a distinct cleanup-pending message and **Retry cleanup**, keeping the new location active.

The five UI languages are English, Simplified Chinese, Traditional Chinese, Japanese and German. The selected mode and progress/error states are reflected in all of them.

## Deletion and recovery contract

The durable transaction is `moepie-data-migration.json` beside the executable; the durable mode pointer is `moepie-data.json`. Do not remove these files to recover a move. An explicit installed-mode pointer takes precedence over a remaining portable `data` folder or `.portable` marker, so returning to the original location does not accidentally reopen stale portable data.

The commit boundary is the mode-pointer switch. Before it, failure rolls back publication and restores the old destination. After it, cleanup errors and interruptions **never roll back to the partly deleted source**. Startup settles interrupted records; a published record is reverified before cleanup, rather than treating a mode pointer as proof of a good copy. Once cleanup has started, missing old files are expected and a retry resumes deletion from the persisted manifest. The new root remains usable when cleanup cannot finish, and the transaction retains errors naming retained data. Retry uses the same helper and quiescence sequence, without copying or switching back.

Deletion is bound to the two fixed directory mappings, the executable, source-root identity, a transaction identity marker, and the persisted file hashes/types. Source and destination overlap, unsafe nesting, executable-directory overlap, redirected roots/ancestors, and filesystem aliases are refused. Root and entry walks reject links rather than following them. Source deletion uses individual checked removals, not a recursive deletion of an external root. New files, changed files, changed identities, and a destination file that no longer matches are retained and reported. Empty source roots and the necessary `.moepie-runtime` coordination markers may remain; the ordinary source data is removed after a successful move.

Windows browser cache, crash/metrics files and lock files are omitted from the copy because WebView2 regenerates them. They are included in the source cleanup manifest and can be removed only after the browser has stopped. Cookies, Local Storage, IndexedDB, preferences and other persistent profile storage are copied and verified. Old destination backups are retained, including their unique contents; the implementation does not automatically prune those backups. A backup can therefore contain an intentionally protected older copy even after ordinary source cleanup succeeds.

An unreadable/malformed transaction or mode pointer is an error, not permission to guess a root or start a new migration. A source or destination layout that fails validation must be corrected before retry. A cleanup retry cannot delete a newly changed file just because it occupies a former source name.

## Implementation and validation

`internal/appdir` resolves the fixed roots. `internal/datamove` owns path validation, leases, manifests, publication, mode switching and resumable cleanup. `internal/gui/datadir.go` coordinates confirmation, admission/draining, process shutdown and helper handoff. `internal/cli/data_directory.go` provides the internal `data-directory migrate` entry used by the helper; this is not a general-purpose directory relocation command.

Synthetic tests cover both directions, nonempty destinations, verification failures preserving the source, rollback before commit, cleanup failure and interruption after commit, cleanup retries, linked/overlapping roots and conditional cache mappings. Browser fixtures cover the two choices, confirmation/cancellation, disabled destinations, pending cleanup, failed and completed results, five languages and wide/narrow layouts. Tests use isolated homes and synthetic files; they do not migrate the user's actual data. Native Windows WebView2 end-to-end migration still requires an isolated desktop smoke test; browser-fixture and helper tests do not claim that native coverage.
