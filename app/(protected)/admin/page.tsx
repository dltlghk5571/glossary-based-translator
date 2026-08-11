"use client";

import { useEffect, useState } from "react";

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
  const [newRole, setNewRole] = useState<"user" | "admin">("user");
  const [issuedCredential, setIssuedCredential] = useState<{ username: string; password: string } | null>(null);
  const [creating, setCreating] = useState(false);

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
              <select value={newRole} onChange={(e) => setNewRole(e.target.value as "user" | "admin")}>
                <option value="user">user</option>
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
    </main>
  );
}
