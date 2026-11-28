import type { QuickReplyLanguage } from './fields';

/**
 * Starter replies an admin can add in one click (Settings → Quick
 * replies). Each one answers in a single message what reps often split
 * across several: greeting + availability + price + next step. Every
 * outbound message is billed, so one complete reply costs a fifth of five
 * short ones. Edit freely after adding.
 */
export interface StarterQuickReply {
  title: string;
  shortcut: string;
  language: QuickReplyLanguage;
  content_text: string;
}

export const STARTER_QUICK_REPLIES: readonly StarterQuickReply[] = [
  {
    title: 'Сәлем + бар + баға',
    shortcut: 'bar',
    language: 'kk',
    content_text:
      'Сәлеметсіз бе, {{name}}! 😊 Иә, бұл тауар бар.\nБағасы: ___ тг.\nТапсырыс рәсімдейміз бе? Қажет болса, суреті мен сипаттамасын жіберемін.',
  },
  {
    title: 'Тауар таусылды',
    shortcut: 'joq',
    language: 'kk',
    content_text:
      'Сәлеметсіз бе, {{name}}! Өкінішке қарай, бұл тауар қазір жоқ. Ұқсас нұсқаларын ұсына аламын — көргіңіз келе ме?',
  },
  {
    title: 'Тапсырыс деректері',
    shortcut: 'zakaz-kk',
    language: 'kk',
    content_text:
      'Тапсырысты рәсімдеу үшін бір хабарламада жазыңызшы:\n1) Аты-жөніңіз\n2) Мекенжай (қала, көше, үй)\n3) Телефон нөміріңіз\n4) Төлем түрі: Kaspi / қолма-қол',
  },
  {
    title: 'Төлем және жеткізу',
    shortcut: 'tolem',
    language: 'kk',
    content_text:
      'Төлем: Kaspi аударым немесе Kaspi QR. Жеткізу: ___ күн ішінде, құны ___ тг. Тапсырысыңыз жіберілгенде, бір хабарламамен трек-нөмірін жіберемін.',
  },
  {
    title: 'Рахмет',
    shortcut: 'rahmet',
    language: 'kk',
    content_text:
      'Тапсырысыңызға рахмет, {{name}}! 🙏 Тапсырыс қабылданды. Жіберілген кезде хабарлаймын.',
  },
  {
    title: 'Привет + есть + цена',
    shortcut: 'est',
    language: 'ru',
    content_text:
      'Здравствуйте, {{name}}! 😊 Да, этот товар есть в наличии.\nЦена: ___ тг.\nОформляем заказ? Если нужно, пришлю фото и описание.',
  },
  {
    title: 'Нет в наличии',
    shortcut: 'net',
    language: 'ru',
    content_text:
      'Здравствуйте, {{name}}! К сожалению, этого товара сейчас нет. Могу предложить похожие варианты — показать?',
  },
  {
    title: 'Данные для заказа',
    shortcut: 'zakaz',
    language: 'ru',
    content_text:
      'Чтобы оформить заказ, напишите одним сообщением:\n1) Имя\n2) Адрес (город, улица, дом)\n3) Номер телефона\n4) Оплата: Kaspi / наличные',
  },
  {
    title: 'Оплата и доставка',
    shortcut: 'oplata',
    language: 'ru',
    content_text:
      'Оплата: перевод Kaspi или Kaspi QR. Доставка: в течение ___ дней, стоимость ___ тг. Когда заказ отправим, пришлю трек-номер одним сообщением.',
  },
  {
    title: 'Спасибо',
    shortcut: 'spasibo',
    language: 'ru',
    content_text:
      'Спасибо за заказ, {{name}}! 🙏 Заказ принят. Сообщу, когда он будет отправлен.',
  },
];
