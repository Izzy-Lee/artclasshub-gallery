// =============================================================
//  Firebase 설정 (Artable 미술 갤러리)
// =============================================================
// 아래 값은 artclass-hub 프로젝트의 실제 설정입니다.
// 웹 전용 앱을 따로 등록하고 싶다면:
//   Firebase 콘솔 → 프로젝트 설정(⚙️) → "내 앱" → 웹 앱 추가(</>)
//   → 나오는 firebaseConfig 값으로 아래를 교체하세요.
// (API 키는 클라이언트에 노출되어도 되는 값입니다. 보안은 Firestore/Storage 규칙으로 합니다.)
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyAcW1Jx01XkI15Ga5Ln3dsSSx0K8f3CsFY",
  authDomain: "artclass-hub.firebaseapp.com",
  projectId: "artclass-hub",
  storageBucket: "artclass-hub.firebasestorage.app",
  messagingSenderId: "122881163606",
  appId: "1:122881163606:web:artclasshubgallery"
};

// =============================================================
//  갤러리 설정
// =============================================================
window.GALLERY_CONFIG = {
  // iOS 공유 확장이 작품을 저장하는 Firestore 컬렉션 이름
  collection: "submissions",

  // 정렬 기준 필드(업로드 시각)
  dateField: "created_at",

  // true  → Firebase 대신 아래 샘플 데이터로 화면을 채웁니다(배포 초기 확인용).
  // false → 실제 Firebase에서 실시간으로 불러옵니다.
  //         (연결 실패/데이터 없음이면 자동으로 샘플로 대체합니다.)
  useSampleData: false,

  // 관리자 모드 비밀번호 (클라이언트 측 — 간단한 학교용 보호).
  // ⚠️ 진짜 보안이 아닙니다. 삭제/숨김을 실제로 막으려면 Firebase Auth + 규칙을 쓰세요.
  adminPassword: "artable2026"
};
