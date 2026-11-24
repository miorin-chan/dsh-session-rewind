const en = {
  pending: 'Pending messages',
  queued: 'Queued',
  steering: 'Waiting to steer',
  empty: 'Empty message',
  undo: 'Undo send',
  undoing: 'Undoing…',
  undone: 'Send undone.',
  tooLate: 'This message has left the queue and can no longer be withdrawn.',
  failed: 'Could not undo send. Try again.',
}

export const labels = {
  en,
  zh: {
    pending: '待发消息', queued: '排队中', steering: '等待插话', empty: '空消息',
    undo: '撤销发送', undoing: '正在撤销…', undone: '已撤销发送。',
    tooLate: '这条消息已离开队列，无法撤销。', failed: '撤销发送失败，请重试。',
  },
  ja: {
    pending: '送信待ちのメッセージ', queued: '待機中', steering: '割り込み待ち', empty: '空のメッセージ',
    undo: '送信を取り消す', undoing: '取り消し中…', undone: '送信を取り消しました。',
    tooLate: 'このメッセージはすでにキューを離れたため取り消せません。', failed: '送信を取り消せませんでした。もう一度お試しください。',
  },
  de: {
    pending: 'Ausstehende Nachrichten', queued: 'In der Warteschlange', steering: 'Als Zwischenruf vorgemerkt', empty: 'Leere Nachricht',
    undo: 'Senden rückgängig machen', undoing: 'Wird zurückgezogen…', undone: 'Senden rückgängig gemacht.',
    tooLate: 'Diese Nachricht hat die Warteschlange verlassen und kann nicht mehr zurückgezogen werden.',
    failed: 'Senden konnte nicht rückgängig gemacht werden. Versuche es erneut.',
  },
  es: {
    pending: 'Mensajes pendientes', queued: 'En cola', steering: 'Intervención pendiente', empty: 'Mensaje vacío',
    undo: 'Deshacer envío', undoing: 'Deshaciendo…', undone: 'Envío deshecho.',
    tooLate: 'El mensaje ya salió de la cola y no se puede retirar.', failed: 'No se pudo deshacer el envío. Inténtalo de nuevo.',
  },
  fr: {
    pending: 'Messages en attente', queued: 'En file d’attente', steering: 'Intervention en attente', empty: 'Message vide',
    undo: 'Annuler l’envoi', undoing: 'Annulation…', undone: 'Envoi annulé.',
    tooLate: 'Ce message a quitté la file d’attente et ne peut plus être retiré.', failed: 'Impossible d’annuler l’envoi. Réessayez.',
  },
  pt: {
    pending: 'Mensagens pendentes', queued: 'Na fila', steering: 'Intervenção pendente', empty: 'Mensagem vazia',
    undo: 'Desfazer envio', undoing: 'Desfazendo…', undone: 'Envio desfeito.',
    tooLate: 'A mensagem já saiu da fila e não pode mais ser retirada.', failed: 'Não foi possível desfazer o envio. Tente novamente.',
  },
  ru: {
    pending: 'Ожидающие сообщения', queued: 'В очереди', steering: 'Ожидает вставки в текущий ход', empty: 'Пустое сообщение',
    undo: 'Отменить отправку', undoing: 'Отмена…', undone: 'Отправка отменена.',
    tooLate: 'Сообщение уже покинуло очередь, и отменить его нельзя.', failed: 'Не удалось отменить отправку. Попробуйте снова.',
  },
} satisfies Record<string, Record<keyof typeof en, string>>
