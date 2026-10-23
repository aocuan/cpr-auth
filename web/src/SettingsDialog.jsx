import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";

// 沿用原配置弹窗的结构与样式，补齐焦点返回和键盘约束
export function SettingsDialog({ title, onClose, busy, children, onSubmit, description }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.querySelector("input:not([disabled]), button:not([disabled])")?.focus();
    return () => { document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  useEffect(() => {
    // 请求期间按钮被禁用会让浏览器丢失焦点，结束后将焦点留在弹窗内
    if (!busy && !ref.current?.contains(document.activeElement)) {
      ref.current?.querySelector('button:not([disabled])')?.focus();
    }
  }, [busy]);
  function onKeyDown(event) {
    if (event.key === "Escape") { event.preventDefault(); if (!busy) onClose(); }
    if (event.key !== "Tab") return;
    const items = [...ref.current.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]')];
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form ref={ref} className="batch-dialog sub2api-settings-dialog" role="dialog" aria-modal="true" aria-label={title} aria-busy={busy} onKeyDown={onKeyDown} onSubmit={onSubmit}>
      <div className="dialog-header">
        <div><h2>{title}</h2><span>{description}</span></div>
        <button type="button" className="icon-button" aria-label="关闭" onClick={onClose} disabled={busy}><X size={18} /></button>
      </div>
      {children}
    </form>
  </div>;
}

