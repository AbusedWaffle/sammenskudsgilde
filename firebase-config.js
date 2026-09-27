// ─────────────────────────────────────────────────────────────────────────────
//  FIREBASE-KONFIGURATION  –  det ENESTE sted der skal ændres ved opsætning.
//
//  Firebase-konsollen → Projektindstillinger → "Dine apps" → Web-app → "SDK setup
//  and configuration" → "Config". Kopiér værdierne ind herunder.
//
//  Disse værdier er IKKE hemmelige (de ender altid i browseren); sikkerheden ligger
//  i firestore.rules + at gilde-ID'et er langt og tilfældigt.
//
//  Sættes projectId til noget der starter med "INDSÆT", kører appen i demotilstand,
//  hvor data kun gemmes i denne browser (localStorage).
//  Kræver: Firestore (eur3) + Authentication → Anonym login slået til + firestore.rules.
// ─────────────────────────────────────────────────────────────────────────────
export const firebaseConfig = {
  apiKey: "AIzaSyB7KrVosbXqzcmfmjPDfQS7R6L0PO1rH8U",
  authDomain: "sammenskudsgilde-848aa.firebaseapp.com",
  projectId: "sammenskudsgilde-848aa",
  storageBucket: "sammenskudsgilde-848aa.firebasestorage.app",
  messagingSenderId: "425323133361",
  appId: "1:425323133361:web:f2b4d9f0552d42f2752590",
};

// Firebase JS SDK-version der hentes fra gstatic (ES-moduler, intet build-trin).
export const FIREBASE_SDK_VERSION = "12.19.0";

export const isConfigured = () => !String(firebaseConfig.projectId || "").startsWith("INDSÆT");
