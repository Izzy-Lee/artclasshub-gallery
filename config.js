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

  // 클래스(반) 등록부 = 구글 스프레드시트 "클래스" 탭.
  //   A 클래스명 | B 코드 | C 비번 | D 사진폴더명 | E 메모
  //   · 반 이름과 반마다 다른 비밀번호를 여기서 읽어 옵니다
  //     (비번 대조는 Apps Script에서만 — 브라우저로는 내려오지 않습니다).
  //   · D열 사진폴더명은 드라이브 기관 폴더 이름이 반 제목과 다를 때만 적습니다.
  classApi: "https://script.google.com/macros/s/AKfycbyV5LibT5DHLAIwujt8u8yjkyBtxpzSMF5T2aepcPdbgvQITCKc7kou4mlqcNxIvLKZ/exec",
  classSecret: "artclasshub-2026",

  // 🔓 비밀번호 없이 누구나 볼 수 있는 반(공개 갤러리).
  // 여기에 적은 반은 스프레드시트 "클래스" 탭 C열(비번)에 값이 남아 있어도
  // 브라우저에서 비밀번호 화면을 띄우지 않습니다.
  // 반 이름 · 반 코드 · 사진폴더명(기관 이름) 중 아무거나 적으면 됩니다.
  //   ⚠️ 이 반의 작품·그림책은 링크만 알면 누구나 볼 수 있게 됩니다.
  //      (아이 얼굴이 담긴 '📷 수업 모습'은 여전히 따로 잠겨 있습니다.)
  openClasses: [
    "백령종합사회복지관",
    "옹진가족센터",
    "옹진군가족센터",
    "영흥지역아동센터",
    "영흥도 다함께돌봄센터",
    "영흥면 행정복지센터"
  ],

  // 📚 그림책 웹앱(뷰어와 같은 Apps Script). 관리자가 학생을 다른 반으로 옮길 때도 쓴다.
  booksApi: "https://script.google.com/macros/s/AKfycbzBg9ghzZSLv0J3MlUWMNVscBQuKVd2JgYS-HyiBAuqzPEh5qbGCUW9o_PorKOILx4/exec",
  booksSecret: "artclasshub-storybook",

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
