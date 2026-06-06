"""Admin REST endpoints (v221.tenants-4).

Lives behind `/api/admin/*`. All endpoints require the admin bearer
(NARRATIVE_KEY env var) — testers can't see or touch each other's
records through here. The auth middleware computes `is_admin` from
the bearer; this module just enforces the flag.

Surface (matches SYNC.md "Admin tenant management endpoints"):

    POST   /api/admin/tenants
           body: {label}
           201 {key, tenant_key, label, created_at}
           ^ This is the ONLY time the raw bearer is emitted. The
             admin captures it from the response and shares it
             out-of-band with the tester (email, paper, whatever).
             A second GET will NOT show it again.

    GET    /api/admin/tenants
           200 {tenants: [{label, tenant_key, created_at, last_seen_at}, ...]}
           Keys are redacted — only the sha256 column is exposed.

    DELETE /api/admin/tenants/{tenant_key}
           200 {ok: true, removed: bool}
           Existing rows under that tenant_key stay in the DB
           (unreachable). Cheap reversibility — admin can restore
           the bearer-→ tenant_key mapping by re-minting if the raw
           bearer survives somewhere.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import library_db


router = APIRouter(prefix="/api/admin", tags=["admin"])


def _require_enabled():
    if not library_db.is_enabled():
        raise HTTPException(
            status_code=503,
            detail=(
                "library sync disabled on this server: "
                f"{library_db.disabled_reason()}"
            ),
        )


def _require_admin(request: Request) -> None:
    """Hard-block tester bearers from every endpoint in this module.
    The middleware already verified the bearer is valid; this gates
    on `is_admin` specifically."""
    if not getattr(request.state, "is_admin", False):
        raise HTTPException(
            status_code=403,
            detail="admin bearer required",
        )


# ──────────────────────────────────────────────────────────────────────
# Tenant mint / list / revoke.
# ──────────────────────────────────────────────────────────────────────


class CreateTenantBody(BaseModel):
    label: str = Field(..., min_length=1, max_length=80)


@router.post("/tenants", status_code=201)
def create_tenant(body: CreateTenantBody, request: Request):
    """Mint a new tester bearer. The raw key is in the response under
    `key` — capture it here, because subsequent GETs redact it."""
    _require_enabled()
    _require_admin(request)
    try:
        record = library_db.create_tenant(body.label)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return record


@router.get("/tenants")
def list_tenants(request: Request, include_keys: bool = False):
    """List every minted tester record. `include_keys=true` is admin-
    rescue-mode only — it re-emits the raw bearer the tester would
    use. Default redacts them. Avoid include_keys outside an
    interactive session: bearers in a screenshot or chat scrollback
    are bearers you've leaked."""
    _require_enabled()
    _require_admin(request)
    return {"tenants": library_db.list_tenants(include_keys=include_keys)}


@router.delete("/tenants/{tenant_key}")
def revoke_tenant(tenant_key: str, request: Request):
    """Remove the directory entry so that bearer no longer authenticates.
    The tenant's existing library rows stay in the DB (orphaned, not
    queried by anyone). To purge them, call DELETE /api/admin/tenants/
    {tenant_key}/data after revoke. (Not implemented yet — flagged in
    SYNC.md as Path C follow-up.)"""
    _require_enabled()
    _require_admin(request)
    if tenant_key == library_db.compute_tenant_key(""):
        # Belt-and-suspenders: a bearer of "" hashes to a known sha
        # that we deliberately don't store in tenants.json. Reject
        # any attempt to delete the local-dev sentinel via this
        # endpoint, just in case someone passes the wrong value.
        raise HTTPException(
            status_code=400,
            detail="cannot revoke local-dev sentinel tenant",
        )
    removed = library_db.revoke_tenant(tenant_key)
    return {"ok": True, "removed": removed}


# ──────────────────────────────────────────────────────────────────────
# Tenant self-check — non-admin endpoint.
#
# Lives here rather than on the library router because it returns
# admin/tenant metadata. Any authenticated client can hit it to learn
# its own tenant_label and is_admin flag — useful for the frontend
# Settings page to show "you're signed in as alice" without exposing
# any other tenant's existence.
# ──────────────────────────────────────────────────────────────────────


@router.get("/whoami")
def whoami(request: Request):
    """Return the caller's tenant_key, label, and is_admin status.
    No admin gate — every authed bearer can ask who they are."""
    return {
        "tenant_key": getattr(request.state, "tenant_key", None),
        "is_admin": getattr(request.state, "is_admin", False),
        "tenant_label": getattr(request.state, "tenant_label", ""),
    }


# ──────────────────────────────────────────────────────────────────────
# Pre-deploy guard (v225v4.5 / #795).
#
# A rolling `fly deploy` mid-synth has produced duplicate clips in
# practice (see the v225v4.3 → v225v4.4 incident: bg-queue synth was
# in flight when v4.4 deployed; the resumption logic added a second
# clip instead of resuming the first). The pre-deploy guard at
# scripts/predeploy_check.ps1 hits this endpoint and refuses to run
# `fly deploy` if any tenant has an active synth job.
#
# Admin-only — this surfaces tenant_keys, which testers shouldn't see.
# ──────────────────────────────────────────────────────────────────────


@router.get("/synth-jobs/active")
def list_active_synth_jobs(request: Request):
    """List every in-flight synth job across all tenants.
    Admin-only. Returns {count, active: [...]} where each entry has
    the job snapshot plus tenant_key + elapsed_sec.
    """
    _require_admin(request)
    import synth_jobs
    jobs = synth_jobs.list_active_jobs()
    return {"count": len(jobs), "active": jobs}
