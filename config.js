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
  adminPassword: "181818",

  // 📷 '수업 모습'에 보여줄 수업(프로그램) 이름.
  // 사진 폴더 이름에 이 말이 들어간 수업만 보여줍니다.
  //   ["창의미술"] → 도자기·서예 등 다른 수업 사진은 갤러리에 안 나옵니다.
  //   []           → 전체 수업(필터 없음).
  photoPrograms: ["창의미술"],

  // 📷 '수업 모습' 사진을 가져올 웹앱 주소.
  // 갤러리 전용 사진 웹앱(gas-gallery-photos)을 배포했다면 그 /exec 주소를 넣으세요.
  // 비워 두면 기존 용역 리포트 웹앱의 사진을 그대로 씁니다.
  photoApi: "https://script.google.com/macros/s/AKfycbzr1e2FoQRlOhCIu3tUQHio-hOe4qxv3xYmeDC5O0hukL5fYCpurc_5z1tm8Mb0-u7-/exec"
};
