const en = {
  undo: 'Undo send', undone: 'Send undone.', unavailable: 'Could not restore the draft.',
}

export const labels = {
  en,
  zh: { undo: '撤销发送', undone: '已撤回。', unavailable: '无法恢复草稿。' },
  ja: { undo: '送信を取り消す', undone: '送信を取り消しました。', unavailable: '下書きを復元できませんでした。' },
  de: { undo: 'Senden rückgängig machen', undone: 'Senden rückgängig gemacht.', unavailable: 'Der Entwurf konnte nicht wiederhergestellt werden.' },
  es: { undo: 'Deshacer envío', undone: 'Envío deshecho.', unavailable: 'No se pudo restaurar el borrador.' },
  fr: { undo: 'Annuler l’envoi', undone: 'Envoi annulé.', unavailable: 'Impossible de restaurer le brouillon.' },
  pt: { undo: 'Desfazer envio', undone: 'Envio desfeito.', unavailable: 'Não foi possível restaurar o rascunho.' },
  ru: { undo: 'Отменить отправку', undone: 'Отправка отменена.', unavailable: 'Не удалось восстановить черновик.' },
} satisfies Record<string, Record<keyof typeof en, string>>
