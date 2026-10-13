# Redis backup and recovery

> **Preview.** For P6 on Kubernetes. **The repository documents no backup or restore procedure.** The approaches
> below are things the manifests make possible, devised from the deployment, not endorsed or tested by the project.

## How Redis is deployed

A single-replica StatefulSet running `redis:7-alpine` (pinned by digest) on a `ReadWriteOnce` volume of **1Gi**
using the cluster's default StorageClass. `setup.sh` warns if there is no default class; without one `redis-0`
stays Pending. The generated configuration is exactly `requirepass`, `appendonly yes` and `dir /data`.

- **No `appendfsync`, `save`, `maxmemory` or eviction policy is set**, so Redis 7 defaults apply. With AOF that
  usually means about one second of writes can be lost on a hard crash (a Redis default, not a repository
  guarantee). Nothing evicts.
- The container limit is **256Mi of memory**, which the data set can outgrow before it fills the 1Gi volume; an OOM
  kill would follow. No relationship between the two is documented.
- Only the supervisor, relay and control plane can reach port 6379. The root filesystem is read-only; only `/data` is
  writable.
- The smoke test deletes `redis-0` and checks that a session survives the AOF reload.

The single-VM and Compose deployments differ: Redis has no named volume there, so removing or replacing the
container loses everything. See [Sessions and turns](../concepts/sessions-and-turns.md).

## What lives in Redis

| Data                                                   | Expires                              | If Redis is lost                                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session logs (`session:<sid>`, `:seq`)                 | **Never**                            | Conversation history is gone                                                                                                                                  |
| Session ownership (`sh:cp:session:<sid>`, owner index) | Never                                | Users no longer see their sessions                                                                                                                            |
| Refresh tokens (`sh:cp:refresh:*`)                     | 30 days idle, 90 days absolute       | **Every client is logged out**                                                                                                                                |
| Audit stream (`sh:cp:audit`, `:anon`)                  | Trimmed to about 1,000,000 / 100,000 | Audit history is gone                                                                                                                                         |
| Config bundles and budget index                        | Bundles 30 days                      | Sessions on a promoted bundle fail with 410 `config_bundle_not_found` until re-promoted                                                                       |
| Detachable-turn logs (`sh:turn:*`)                     | `SH_TURN_LOG_TTL_S` (24 h)           | Re-attach to recent turns fails                                                                                                                               |
| Leaf results (`leaf:result:<sid>`)                     | `LEAF_RESULT_TTL_SECONDS` (24 h)     | Stored results are gone                                                                                                                                       |
| Sandbox presence (`sh:sandbox:records`)                | None                                 | Rebuilt when sandboxes (re)attach to the relay; whether already-attached sandboxes rewrite it after a Redis-only wipe is unverified, so restart the sandboxes |
| Affinity, detach marks, leases                         | Affinity 24 h; leases about 60 s     | Pinning is lost; leases heal within seconds                                                                                                                   |

**Credentials are not in Redis.** Per-user credentials are Kubernetes Secrets in the `moca-credentials` namespace,
encrypted under `SH_CREDENTIAL_KEK`. Losing Redis leaves them intact; back up those Secrets too.

## Backing up

Not documented. Options, none tested here:

1. **A volume snapshot** of the PVC `data-redis-0`, if your StorageClass supports CSI snapshots.
2. **An RDB or AOF copy** taken through `kubectl exec redis-0`. `REDISCLI_AUTH` is already in the container
   environment, so `redis-cli` needs no password argument, and `setup.sh` itself uses `kubectl exec ... redis-cli`.
   The root filesystem is read-only, so write to `/data` or stream the file out.
3. **Sessions are append-only streams**, so a periodic copy is consistent per session; a copy taken mid-turn may lack
   the entries still queued in the worker (they are written behind the model loop).

Because sessions never expire, plan **retention**: delete sessions you no longer need
(`mocactl sessions delete ID`, which also removes the log and stored leaf results) and watch Redis memory against
256Mi and the volume against 1Gi.

## Restoring

No ordering is required. The control plane and supervisor reconnect to Redis on their own with bounded backoff, and
the control plane's `/readyz` reports 503 while Redis is down and recovers by itself. With Redis down, session
routes return 503 `redis_unavailable` while credential routes keep working.

If you restore an older snapshot, session records may reference entries newer than the snapshot. The behaviour is
not verified.

## Secrets to back up separately

Everything below is created once by `setup.sh` and never rotated by it.

| Secret                               | Contents                                                                                                 | If lost                                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `moca-mu1`                           | `SH_SESSION_TOKEN_PRIVATE_KEY`, `SH_SESSION_TOKEN_PUBLIC_KEYS`, `SH_CREDENTIAL_KEK`, `SH_EXCHANGE_TOKEN` | **Losing the KEK makes every stored credential unreadable**, with no way back without the old key. Losing the signing key logs everyone out |
| `moca-credentials` namespace Secrets | One encrypted Secret per user                                                                            | Users must re-add their credentials                                                                                                         |
| `moca-redis`                         | The Redis password and `redis.conf`, re-derived on every run                                             | Re-run `setup.sh`; restart Redis and its consumers                                                                                          |
| `moca-relay`, `moca-relay-attach`    | Relay tokens                                                                                             | Restart the relay, supervisor and sandboxes after a change                                                                                  |

### Rotating keys

- **Credential KEK:** `SH_CREDENTIAL_KEK` is a comma-separated ring, newest first. The newest key seals, and every key
  is tried to open, so a rotation prepends a new key, lets writes re-seal forward, and later drops the old key.
  Each entry must be exactly 32 bytes, and a credential sealed under a dropped key reads as an error. **`setup.sh`
  cannot do this**: it only fills missing keys, and deleting `moca-mu1` and re-running generates a _new_ KEK and
  destroys every stored credential.
- **Token signing key:** the verifier accepts a list of `<kid>:<public key>` entries, so a rotation publishes the new
  key beside the old, rolls the verifier, then switches signing. Deleting `moca-mu1` replaces the key with no overlap
  and logs every client out. Whether a client can refresh through such a change without logging in again is not
  verified.
