"use client";

import { useEffect, useState } from "react";
import { adminListQuotas, adminListTopUps, adminResolveTopUp, adminUpdateQuotaLimit } from "@/lib/api";
import type { OrgQuota, TopUpRequest } from "@/lib/types";

type AdminUser = { id: number; username: string; role: string; createdAt: string };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data as T;
}

export default function AdminPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newRole, setNewRole] = useState<"user" | "editor" | "admin">("user");
  const [issuedCredential, setIssuedCredential] = useState<{ username: string; password: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [orgs, setOrgs] = useState<OrgQuota[]>([]);
  const [topUps, setTopUps] = useState<TopUpRequest[]>([]);
  const [grantAmounts, setGrantAmounts] = useState<Record<number, string>>({});

  async function loadQuotaData() {
    try {
      const [{ orgs }, { requests }] = await Promise.all([adminListQuotas(), adminListTopUps()]);
      setOrgs(orgs);
      setTopUps(requests);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load quota data");
    }
  }

  async function load() {
    setLoading(true);
    setError("");
    try {
      const { users } = await request<{ users: AdminUser[] }>("/api/admin/users");
      setUsers(users);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    loadQuotaData();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newUsername.trim()) return;
    setCreating(true);
    setError("");
    try {
      const { user, password } = await request<{ user: AdminUser; password: string }>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ username: newUsername.trim(), role: newRole }),
      });
      setIssuedCredential({ username: user.username, password });
      setNewUsername("");
      setNewRole("user");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create user");
    } finally {
      setCreating(false);
    }
  }

  async function handleResetPassword(id: number) {
    setError("");
    try {
      const { user, password } = await request<{ user: AdminUser; password: string }>(`/api/admin/users/${id}`, {
        method: "PATCH",
      });
      setIssuedCredential({ username: user.username, password });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset password");
    }
  }

  async function handleDelete(id: number, username: string) {
    if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
    setError("");
    try {
      await request(`/api/admin/users/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete user");
    }
  }

  async function handleUpdateLimit(userId: number, monthlyTokenLimit: number) {
    setError("");
    try {
      await adminUpdateQuotaLimit(userId, monthlyTokenLimit);
      await loadQuotaData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update limit");
    }
  }

  async function handleResolveTopUp(id: number, action: "approve" | "deny") {
    setError("");
    try {
      const grantedTokens = action === "approve" ? Number(grantAmounts[id] || 0) : undefined;
      if (action === "approve" && (!grantedTokens || grantedTokens <= 0)) {
        setError("지급할 토큰 수를 입력하세요.");
        return;
      }
      await adminResolveTopUp(id, action, grantedTokens);
      await loadQuotaData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve request");
    }
  }

  return (
    <main className="page">
      <div className="page-header">
        <div>
          <h1>Admin</h1>
          <p className="subtitle">사용자 계정을 발급하고 관리합니다.</p>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}

      <section className="card">
        <h2 style={{ marginTop: 0, fontSize: 15 }}>새 계정 발급</h2>
        <form onSubmit={handleCreate}>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
            <label className="field" style={{ flex: 1, minWidth: 160, marginBottom: 0 }}>
              <span>Username</span>
              <input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="username" />
            </label>
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Role</span>
              <select value={newRole} onChange={(e) => setNewRole(e.target.value as "user" | "editor" | "admin")}>
                <option value="user">user</option>
                <option value="editor">editor</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <button type="submit" className="btn btn-primary" disabled={creating || !newUsername.trim()}>
              {creating ? "Creating..." : "Create"}
            </button>
          </div>
        </form>
        <p className="hint" style={{ marginTop: 8 }}>
          비밀번호는 자동 생성되며, 발급 직후 한 번만 표시됩니다.
        </p>

        {issuedCredential && (
          <div className="secret-callout">
            <strong>{issuedCredential.username}</strong> 계정 비밀번호 (지금만 표시됩니다 — 저장해두세요):
            <br />
            <code>{issuedCredential.password}</code>
          </div>
        )}
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0, fontSize: 15 }}>계정 목록</h2>
        {loading ? (
          <p className="hint">Loading...</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Role</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.username}</td>
                    <td>
                      <span className={`badge ${u.role === "admin" ? "badge-admin" : ""}`}>{u.role}</span>
                    </td>
                    <td className="hint">{new Date(u.createdAt).toLocaleDateString()}</td>
                    <td>
                      <div className="btn-row">
                        <button className="btn btn-sm" onClick={() => handleResetPassword(u.id)}>
                          Reset password
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={() => handleDelete(u.id, u.username)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0, fontSize: 15 }}>단체별 토큰 쿼터</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Username</th>
                <th>사용량</th>
                <th>월 한도</th>
                <th>보너스</th>
                <th>잔여</th>
                <th>한도 수정</th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((org) => (
                <tr key={org.id}>
                  <td>{org.username}</td>
                  <td>{org.tokensUsedThisPeriod.toLocaleString()}</td>
                  <td>{org.monthlyTokenLimit.toLocaleString()}</td>
                  <td>{org.bonusTokens.toLocaleString()}</td>
                  <td>{(org.monthlyTokenLimit + org.bonusTokens - org.tokensUsedThisPeriod).toLocaleString()}</td>
                  <td>
                    <input
                      type="number"
                      defaultValue={org.monthlyTokenLimit}
                      style={{ width: 100 }}
                      onBlur={(e) => {
                        const value = Number(e.target.value);
                        if (Number.isInteger(value) && value >= 0 && value !== org.monthlyTokenLimit) {
                          handleUpdateLimit(org.id, value);
                        }
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0, fontSize: 15 }}>충전 요청 ({topUps.length})</h2>
        {topUps.length === 0 ? (
          <p className="hint">대기 중인 요청이 없습니다.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>사유</th>
                  <th>요청일</th>
                  <th>지급 토큰</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {topUps.map((t) => (
                  <tr key={t.id}>
                    <td>{t.user.username}</td>
                    <td className="hint">{t.note || "-"}</td>
                    <td className="hint">{new Date(t.createdAt).toLocaleDateString()}</td>
                    <td>
                      <input
                        type="number"
                        placeholder="예: 20000"
                        style={{ width: 100 }}
                        value={grantAmounts[t.id] || ""}
                        onChange={(e) => setGrantAmounts((prev) => ({ ...prev, [t.id]: e.target.value }))}
                      />
                    </td>
                    <td>
                      <div className="btn-row">
                        <button className="btn btn-sm" onClick={() => handleResolveTopUp(t.id, "approve")}>
                          승인
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={() => handleResolveTopUp(t.id, "deny")}>
                          거절
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
