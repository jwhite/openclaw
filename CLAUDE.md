@AGENTS.md

## Deployment notes (this user's setup)

**Canonical source of truth for this deployment is the `fairlead-ops` repo** (`c:\dev\fairlead-ops`, github `jwhite/fairlead-ops`) — see `stacks/openclaw.md`, `stacks/ocp.md`, `stacks/repoql-mcp.md`, `decisions/`, `runbooks/`. Do not duplicate facts from there into this file; read it (it is RepoQL-indexed).

Quick pointers only:
- openclaw runs on Proxmox LXC 100 (not the NAS). Live config: `\\nas\proxmox\appdata\openclaw\config\openclaw.json`. Workspace `/opt/openclaw/workspace` (LXC-local) = `/home/node/clawd` in-container.
- Ops: `ssh proxmox1` then `pct exec 100 -- docker <cmd> openclaw`.
- Old `\\nas\docker\openclaw\config\` paths are dead — never edit those.
