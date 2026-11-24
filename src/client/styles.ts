// Reuse the composer width custom properties from @deepseek-ai/dsh-client-ui-conversation
// 0.2.2-rc.5, src/client/queue/QueueDock.module.css (.dock).
export const styles = `
.dsh-undo-announcement {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.dsh-undo-announcement[data-visible] {
  position: static;
  width: fit-content;
  height: auto;
  clip-path: none;
  margin-inline: auto;
  padding: 3px 10px;
  border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
  font-size: var(--dsh-content-font-size-secondary, 13px);
}
.dsh-undo-send {
  box-sizing: border-box;
  width: min(calc(100% - 2 * var(--dsh-composer-side-clearance, 16px)), var(--dsh-composer-card-max-width, 748px));
  flex: none;
  margin-inline: auto;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-lg);
}
.dsh-undo-heading {
  padding: 6px 10px 2px;
  color: var(--dsw-alias-label-secondary);
  font-size: var(--dsh-content-font-size-secondary, 13px);
}
.dsh-undo-list {
  list-style: none;
  max-block-size: min(36dvh, 260px);
  min-block-size: 58px;
  padding: 0;
  margin: 0;
  overflow: auto;
  overscroll-behavior: contain;
}
.dsh-undo-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px 6px;
}
.dsh-undo-row + .dsh-undo-row { border-block-start: 1px solid var(--dsw-alias-border-l1); }
.dsh-undo-state {
  align-self: flex-end;
  color: var(--dsw-alias-label-secondary);
  font-size: var(--dsh-content-font-size-secondary, 13px);
}
.dsh-undo-preview {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  max-block-size: min(18dvh, 120px);
  overflow: auto;
  overscroll-behavior: contain;
}
.dsh-undo-actions { display: flex; align-items: center; justify-content: flex-end; gap: 4px; }
.dsh-undo-action {
  box-sizing: border-box;
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  cursor: pointer;
}
.dsh-undo-action[data-dsh-undo] {
  color: var(--dsw-alias-brand-text);
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-undo-action[aria-disabled="true"] { opacity: 0.45; cursor: default; }
.dsh-undo-action:focus-visible, .dsh-undo-edit:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
@media (hover: hover) {
  .dsh-undo-action:hover:not([aria-disabled="true"]) { background: var(--dsw-alias-interactive-bg-active); }
}
@media (pointer: coarse) {
  .dsh-undo-action { width: 44px; height: 44px; }
  .dsh-undo-edit { font-size: max(16px, var(--dsh-content-font-size, 14px)); }
}
.dsh-undo-edit {
  box-sizing: border-box;
  width: 100%;
  padding: 8px 10px;
  resize: vertical;
  color: inherit;
  font-family: inherit;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-base);
}
`
