import type { Recording } from './types';

function encodeWavBlob(notesHz: number[], durationSec = 8): string {
  const sampleRate = 16000;
  const numSamples = Math.floor(sampleRate * durationSec);
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  const stepDuration = durationSec / notesHz.length;
  for (let i = 0; i < numSamples; i += 1) {
    const t = i / sampleRate;
    const stepIdx = Math.min(notesHz.length - 1, Math.floor(t / stepDuration));
    const localT = t - stepIdx * stepDuration;
    const freq = notesHz[stepIdx];
    const attack = Math.min(1, localT / 0.08);
    const decay = Math.exp(-localT * 1.45);
    const fadeOut = Math.min(1, (durationSec - t) / 0.35);
    const env = attack * decay * fadeOut;

    const tone =
      Math.sin(2 * Math.PI * freq * t) * 0.65 +
      Math.sin(2 * Math.PI * freq * 2 * t) * 0.22 +
      Math.sin(2 * Math.PI * freq * 0.5 * t) * 0.13;

    const sample = Math.max(-1, Math.min(1, tone * env * 0.22));
    view.setInt16(44 + i * 2, Math.round(sample * 32767), true);
  }

  const blob = new Blob([buffer], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}

const audioCache = new Map<string, string>();

export function getFixtureAudioUrl(id: string, chord: number[]): string {
  const existing = audioCache.get(id);
  if (existing) return existing;
  const url = encodeWavBlob(chord, 8);
  audioCache.set(id, url);
  return url;
}

const now = Date.now();
const hoursAgo = (h: number) => new Date(now - h * 3600 * 1000).toISOString();

export const INITIAL_FIXTURES: Recording[] = [
  {
    id: 'rec_20261122_143502_a1b2',
    title: 'Weekend trip ideas for Lisbon',
    created: hoursAgo(1.2),
    durationSeconds: 84,
    language: 'es',
    languageName: 'Spanish',
    isEnglish: false,
    status: 'ready',
    summary:
      'Look into flights for next month and ask Ana for neighborhood recommendations.',
    tags: ['travel', 'personal'],
    audioPath: 'audio/rec_20261122_143502_a1b2.webm',
    audioMimeType: 'audio/wav',
    audioUrl: getFixtureAudioUrl('rec_20261122_143502_a1b2', [261.63, 329.63, 392.0, 493.88]),
    englishTranscript:
      'Quick note before I forget: we should look at direct flights to Lisbon for the second weekend of next month, ideally leaving Thursday evening so we get a full Friday.\n\nI want to ask Ana which neighborhoods feel quietest in the morning—maybe Príncipe Real or Estrela instead of staying right in Baixa. Also save that small seafood place near Santos she mentioned last summer, and check whether the tile museum needs advance tickets.',
    originalTranscript:
      'Nota rápida antes de que se me olvide: deberíamos mirar vuelos directos a Lisboa para el segundo fin de semana del mes que viene, idealmente saliendo el jueves por la tarde para aprovechar todo el viernes.\n\nQuiero preguntarle a Ana qué barrios son más tranquilos por la mañana—quizás Príncipe Real o Estrela en vez de quedarnos justo en Baixa. También guardar aquel sitio pequeño de marisco cerca de Santos que mencionó el verano pasado, y comprobar si el museo del azulejo necesita entradas anticipadas.',
  },
  {
    id: 'rec_20261122_111840_c4d9',
    title: 'Dentist reschedule & pharmacy pickup',
    created: hoursAgo(4.5),
    durationSeconds: 42,
    language: 'en',
    languageName: 'English',
    isEnglish: true,
    status: 'ready',
    summary:
      'Move Thursday morning cleaning to Tuesday afternoon and pick up allergy drops on the way back.',
    tags: ['errands', 'personal'],
    audioPath: 'audio/rec_20261122_111840_c4d9.webm',
    audioMimeType: 'audio/wav',
    audioUrl: getFixtureAudioUrl('rec_20261122_111840_c4d9', [293.66, 369.99, 440.0, 554.37]),
    englishTranscript:
      'Call Dr. Morales’s office before three to move Thursday’s cleaning to next Tuesday afternoon—any slot after two works.\n\nOn the walk home, stop by the corner pharmacy for the prescription eye drops and grab extra oat milk so we’re set for the morning.',
  },
  {
    id: 'rec_20261121_184215_f8e1',
    title: 'Q4 onboarding friction notes from Camille',
    created: hoursAgo(21),
    durationSeconds: 138,
    language: 'fr',
    languageName: 'French',
    isEnglish: false,
    status: 'ready',
    summary:
      'Simplify the workspace invite step and surface the CSV import template before the first empty state.',
    tags: ['work', 'product', 'ideas'],
    audioPath: 'audio/rec_20261121_184215_f8e1.webm',
    audioMimeType: 'audio/wav',
    audioUrl: getFixtureAudioUrl('rec_20261121_184215_f8e1', [220.0, 261.63, 329.63, 392.0]),
    englishTranscript:
      'Just walked out of the sync with Camille about Q4 onboarding. The biggest drop-off isn’t account creation—it’s the team invite screen right after. Solo evaluators feel forced to invite colleagues before they’ve even tried the tool.\n\nWe should make inviting teammates clearly optional and let people load a tiny realistic sample workspace in one click. Also, for teams bringing data from spreadsheets, put the downloadable CSV template directly on the empty-state card instead of burying it inside the help center.',
    originalTranscript:
      "Je sors tout juste du point avec Camille sur l'onboarding du quatrième trimestre. Le plus gros décrochage ne se fait pas à la création du compte, mais sur l'écran d'invitation d'équipe juste après. Les personnes qui testent seules ont l'impression de devoir inviter des collègues avant même d'avoir essayé l'outil.\n\nOn devrait rendre l'invitation clairement optionnelle et permettre de charger un petit espace d'exemple réaliste en un clic. Et pour les équipes qui importent des tableurs, il faut mettre le modèle CSV directement sur la carte d'état vide au lieu de le cacher dans le centre d'aide.",
  },
  {
    id: 'rec_20261120_091522_k3m7',
    title: 'Pour-over grind settings & Kyoto roaster',
    created: hoursAgo(54),
    durationSeconds: 65,
    language: 'ja',
    languageName: 'Japanese',
    isEnglish: false,
    status: 'ready',
    summary:
      'Washed Ethiopian beans tasted cleanest at 22 clicks on Comandante with 93°C water and a 45-second bloom.',
    tags: ['coffee', 'journal', 'ideas'],
    audioPath: 'audio/rec_20261120_091522_k3m7.webm',
    audioMimeType: 'audio/wav',
    audioUrl: getFixtureAudioUrl('rec_20261120_091522_k3m7', [246.94, 293.66, 369.99, 440.0]),
    englishTranscript:
      'Brew log for the washed Ethiopian bag from Weekenders Coffee in Kyoto: fifteen grams in, two hundred fifty grams out at ninety-three degrees.\n\nOpening up the grind slightly to twenty-two clicks on the Comandante cleared up the finish right away—bright jasmine and white peach without any dryness. Keep the bloom at forty-five seconds and do two gentle center pours.',
    originalTranscript:
      '京都のWeekenders Coffeeで買ったエチオピア・ウォッシュドの抽出メモ。豆は15グラム、お湯は93度で250グラムまで。\n\nコマンダンテを少し粗めの22クリックにしたら後味がすっきりして、ジャスミンと白桃みたいな香りがきれいに出た。蒸らしは45秒で、その後は真ん中にゆっくり2回注ぐのが一番バランスがいい。',
  },
  {
    id: 'rec_20261118_075109_p2q8',
    title: 'Quiet morning walk — essay opening hook',
    created: hoursAgo(102),
    durationSeconds: 111,
    language: 'en',
    languageName: 'English',
    isEnglish: true,
    status: 'ready',
    summary:
      'Start the calm-software essay with the feeling of an analog pocket recorder instead of productivity stats.',
    tags: ['writing', 'ideas', 'journal'],
    audioPath: 'audio/rec_20261118_075109_p2q8.webm',
    audioMimeType: 'audio/wav',
    audioUrl: getFixtureAudioUrl('rec_20261118_075109_p2q8', [196.0, 246.94, 293.66, 392.0]),
    englishTranscript:
      'For the essay on calm tools, cut the opening paragraph about notification fatigue—everyone has read that version ten times already.\n\nStart instead with a physical object: an old pocket tape recorder with one recessed red button and a mechanical counter. You don’t organize your thoughts before pressing record; you trust the tape to hold them until you’re back at your desk. Good personal software should feel that unhurried.',
  },
];
