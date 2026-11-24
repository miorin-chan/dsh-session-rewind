const en = {
  undo: 'Undo send', undone: 'Send undone.', restored: 'Text returned to the draft.', unavailable: 'Could not restore the draft.',
}

export const labels = {
  en,
  zh: { undo: '撤销发送', undone: '已撤回。', restored: '已放回草稿。', unavailable: '无法恢复草稿。' },
  ja: { undo: '送信を取り消す', undone: '送信を取り消しました。', restored: '本文を下書きに戻しました。', unavailable: '下書きを復元できませんでした。' },
  de: { undo: 'Senden rückgängig machen', undone: 'Senden rückgängig gemacht.', restored: 'Text in den Entwurf zurückgelegt.', unavailable: 'Der Entwurf konnte nicht wiederhergestellt werden.' },
  es: { undo: 'Deshacer envío', undone: 'Envío deshecho.', restored: 'Texto devuelto al borrador.', unavailable: 'No se pudo restaurar el borrador.' },
  fr: { undo: 'Annuler l’envoi', undone: 'Envoi annulé.', restored: 'Texte remis dans le brouillon.', unavailable: 'Impossible de restaurer le brouillon.' },
  pt: { undo: 'Desfazer envio', undone: 'Envio desfeito.', restored: 'Texto devolvido ao rascunho.', unavailable: 'Não foi possível restaurar o rascunho.' },
  ru: { undo: 'Отменить отправку', undone: 'Отправка отменена.', restored: 'Текст возвращён в черновик.', unavailable: 'Не удалось восстановить черновик.' },
} satisfies Record<string, Record<keyof typeof en, string>>
