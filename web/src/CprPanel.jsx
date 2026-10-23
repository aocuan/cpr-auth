import { SettingsDialog } from "./SettingsDialog.jsx";
import React, { useEffect, useState } from "react";
import { Check, CircleAlert, LoaderCircle, RotateCcw, Send, Settings2 } from "lucide-react";

export async function cprRequest(token, route, body) {
  const response = await fetch(`/api/cpr/${route}`, { method: body ? 'POST' : 'GET', headers: { 'x-console-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'CPR 请求失败');
  return result;
}

const emptyConfig = { baseUrl: "", adminApiKey: "", groupIds: [], outboundProxyId: "", autoSync: false };
export function CprPanel({ token }) {
  const [saved, setSaved] = useState(emptyConfig);
  const [draft, setDraft] = useState(emptyConfig);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState({ groups: [], proxies: [] });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!token) return;
    let stopped = false;
    cprRequest(token, "config").then(value => { if (!stopped) setSaved({ ...emptyConfig, ...value }); }).catch(error => { if (!stopped) setError(error.message); });
    return () => { stopped = true; };
  }, [token]);
  function openSettings() {
    setDraft({ ...saved, adminApiKey: "", groupIds: [...saved.groupIds] });
    setError(""); setNotice(""); setOpen(true);
  }
  async function act(save) {
    setBusy(save ? "save" : "read"); setError(""); setNotice("");
    try {
      if (save) {
        const value = await cprRequest(token, "config", draft);
        setSaved({ ...emptyConfig, ...value }); setDraft(emptyConfig); setOpen(false);
      } else {
        setOptions(await cprRequest(token, "options", { config: draft }));
        setNotice("连接成功，已读取分组与代理");
      }
    } catch (error) { setError(error.message); }
    finally { setBusy(""); }
  }
  function changeAddress(value) {
    setDraft(current => ({ ...current, baseUrl: value, groupIds: [], outboundProxyId: "" }));
    setOptions({ groups: [], proxies: [] }); setNotice("");
  }
  const groups = [...options.groups];
  for (const id of draft.groupIds) if (!groups.some(group => group.id === id)) groups.push({ id, name: id, enabled: true });
  const proxies = [...options.proxies];
  if (draft.outboundProxyId && !proxies.some(proxy => proxy.id === draft.outboundProxyId)) proxies.push({ id: draft.outboundProxyId, name: draft.outboundProxyId, enabled: true });
  return <>
    <div className="provider-toolbar sub2api-toolbar" aria-label="Codex Proxy RS 配置">
      <div className="provider-heading"><Send size={17} /><strong>Codex Proxy RS</strong></div>
      <span className="provider-name">{saved.baseUrl || "未配置后端"}</span>
      <span className={`provider-ready ${saved.configured ? "" : "incomplete"}`}>
        {saved.configured ? <Check size={14} /> : <CircleAlert size={14} />}
        {saved.configured ? `已配置${saved.groupIds.length ? ` · ${saved.groupIds.length} 个分组` : ""}${saved.autoSync ? " · 自动同步" : ""}` : "未完成配置"}
      </span>
      <button type="button" className="secondary-button provider-settings-button" onClick={openSettings} disabled={!token} aria-label="配置 Codex Proxy RS"><Settings2 size={16} />配置</button>
    </div>
    {!open && error && <div className="row-error" role="alert">{error}</div>}
    {open && <SettingsDialog title="CPR 配置" description="授权账号同步" busy={Boolean(busy)} onClose={() => { setOpen(false); setDraft(emptyConfig); }} onSubmit={event => { event.preventDefault(); void act(true); }}>
      <div className="provider-config-grid sub2api-config-grid">
        <label className="settings-field wide-settings-field"><span>CPR 后端地址</span><input required type="url" disabled={Boolean(busy)} value={draft.baseUrl} placeholder="例如 http://127.0.0.1:8080" onChange={event => changeAddress(event.target.value)} /></label>
        <label className="settings-field wide-settings-field"><span>管理员 API Key</span><input type="password" disabled={Boolean(busy)} autoComplete="off" value={draft.adminApiKey} placeholder={saved.hasAdminApiKey ? "已保存，留空保留" : "输入 CPR 管理员 API Key"} onChange={event => setDraft({ ...draft, adminApiKey: event.target.value })} /></label>
        <fieldset className="settings-field wide-settings-field sub2api-group-field" disabled={Boolean(busy)}>
          <legend>目标分组（可多选）</legend>
          <section className="sub2api-group-picker" aria-label="目标分组">
            {groups.length ? groups.map(group => <label key={group.id} className="sub2api-group-option">
              <input type="checkbox" disabled={!group.enabled} checked={draft.groupIds.includes(group.id)} onChange={event => setDraft({ ...draft, groupIds: event.target.checked ? [...draft.groupIds, group.id] : draft.groupIds.filter(id => id !== group.id) })} />
              <span>{group.name}</span><small>{group.enabled ? `ID: ${group.id}` : "已停用"}</small>
            </label>) : <div className="sub2api-group-empty">读取配置后选择分组</div>}
          </section>
          <section className="sub2api-group-selection" aria-label="分组选择操作">
            <span>已选 {draft.groupIds.length} 个</span>
            <button type="button" disabled={!groups.some(group => group.enabled)} onClick={() => setDraft({ ...draft, groupIds: groups.filter(group => group.enabled).map(group => group.id) })}>全选</button>
            <button type="button" disabled={!draft.groupIds.length} onClick={() => setDraft({ ...draft, groupIds: [] })}>清空</button>
          </section>
        </fieldset>
        <label className="settings-field wide-settings-field"><span>CPR 导入代理</span><select disabled={Boolean(busy)} value={draft.outboundProxyId} onChange={event => setDraft({ ...draft, outboundProxyId: event.target.value })}><option value="">不指定代理</option>{proxies.map(proxy => <option key={proxy.id} value={proxy.id} disabled={!proxy.enabled}>{proxy.name}</option>)}</select></label>
        <label className="settings-field wide-settings-field sub2api-monitor-toggle"><input type="checkbox" disabled={Boolean(busy)} checked={draft.autoSync} onChange={event => setDraft({ ...draft, autoSync: event.target.checked })} /><span><strong>授权完成后自动同步</strong><small>已有任务可在列表中手动同步</small></span></label>
      </div>
      <div className="dialog-hint">不选分组时保留账号原设置；选择分组会替换分组、启用账号、设权重为 1 并继承并发上限。导入代理仅用于 CPR，登录代理需单独配置。</div>
      {notice && <div className="sub2api-monitor-status" role="status"><Check size={15} /><span>{notice}</span></div>}
      {error && <div className="dialog-error" role="alert"><CircleAlert size={15} />{error}</div>}
      <div className="dialog-actions sub2api-dialog-actions">
        <button type="button" className="secondary-button" aria-label="读取 CPR 配置" disabled={Boolean(busy)} onClick={() => act(false)}>{busy === "read" ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}读取配置</button>
        <span className="dialog-actions-spacer" />
        <button type="button" className="cancel-button" disabled={Boolean(busy)} onClick={() => { setOpen(false); setDraft(emptyConfig); }}>取消</button>
        <button type="submit" className="primary-button" disabled={Boolean(busy)}>{busy === "save" ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}保存配置</button>
      </div>
    </SettingsDialog>}
  </>;
}

export function CprStatus({ job, token }) {
  const record = job.cprSync;
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [confirmedAbsent, setConfirmedAbsent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!record) return job.canDownload ? <div className="prompt-line">CPR：尚未同步</div> : null;
  async function reconcile(event) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await cprRequest(token, "reconcile", { id: job.id, ...(confirmedAbsent ? { confirmNotImported: true } : { accountId }) });
      setOpen(false);
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  return <>
    <div className={record.status === "failed" || record.status === "unknown" ? "row-error" : "prompt-line"} title={record.accountIds?.length ? `CPR 账号：${record.accountIds.join(", ")}` : undefined}>CPR：{record.message}</div>
    {record.status === "unknown" && <button type="button" className="secondary-button" aria-label="核对 CPR 同步结果" onClick={() => { setError(""); setOpen(true); }}><CircleAlert size={15} />核对结果</button>}
    {open && <SettingsDialog title="核对同步结果" description={job.email} busy={busy} onClose={() => setOpen(false)} onSubmit={reconcile}>
      <div className="provider-config-grid sub2api-config-grid">
        <label className="settings-field wide-settings-field"><span>已入库的 CPR 账号 ID</span><input required={!confirmedAbsent} disabled={confirmedAbsent || busy} value={accountId} onChange={event => setAccountId(event.target.value)} placeholder="在 CPR 账号详情中核对后填写" /></label>
        <label className="settings-field wide-settings-field sub2api-monitor-toggle"><input type="checkbox" disabled={busy} checked={confirmedAbsent} onChange={event => setConfirmedAbsent(event.target.checked)} /><span><strong>已核对 CPR，确认没有入库</strong><small>确认后允许再次手动同步</small></span></label>
      </div>
      <div className="dialog-hint">已入库时填写对应账号 ID，系统会核对平台与邮箱。确认未入库后再手动同步；判断错误可能导致重复更新。</div>
      {error && <div className="dialog-error" role="alert"><CircleAlert size={15} />{error}</div>}
      <div className="dialog-actions sub2api-dialog-actions">
        <span className="dialog-actions-spacer" />
        <button type="button" className="cancel-button" disabled={busy} onClick={() => setOpen(false)}>取消</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{confirmedAbsent ? "确认未入库" : "确认关联"}</button>
      </div>
    </SettingsDialog>}
  </>;
}
