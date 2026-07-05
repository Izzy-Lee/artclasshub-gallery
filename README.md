# 🎨 Artable 미술 갤러리

Artable 미술 수업 학생 작품을 보여주는 **정적 웹 갤러리**입니다.
iOS 앱(ArtClassHub)의 공유 확장이 Firebase에 올린 작품을 **실시간**으로 표시합니다.

**배포 주소(예정):** https://izzy-lee.github.io/artclasshub

---

## ✨ 기능

- Firebase Firestore 작품 **실시간 로드**(자동 새로고침 없이 새 작품 반영)
- 학급별 **필터**, 학생명 **검색**, 업로드 날짜 **정렬**
- 반응형 **그리드**(PC 3열 / 태블릿 2열 / 모바일 1열)
- 썸네일 클릭 → **큰 이미지** 보기
- **다운로드**(학교 기록용) · **공유**(SNS/링크 복사)
- **관리자 모드**(비밀번호) → 작품 **숨김/삭제**
- Firebase 미연결/데이터 없음이면 **샘플 데이터**로 자동 대체 (배포 즉시 화면 확인 가능)

---

## 📁 폴더 구조

```
artclasshub/
├── index.html   # 전체 마크업
├── style.css    # 반응형 스타일 (흰 배경 + 파란 accent)
├── script.js    # 데이터 로드 + 인터랙션
├── config.js    # Firebase 설정 + 갤러리 옵션
└── README.md
```

---

## 🔧 1. Firebase 설정

`config.js`에는 이미 `artclass-hub` 프로젝트 값이 들어 있습니다. 그대로 써도 되고,
웹 전용 앱을 등록해 정식 값으로 바꾸려면:

1. [Firebase 콘솔](https://console.firebase.google.com/project/artclass-hub) → **프로젝트 설정(⚙️)** → **내 앱** → **웹 앱 추가(`</>`)**
2. 나오는 `firebaseConfig` 값을 `config.js`의 `FIREBASE_CONFIG`에 붙여넣기

### 공개 읽기 규칙 (학교용)

갤러리는 누구나 볼 수 있어야 하므로 **읽기는 공개**로 둡니다.

**Firestore 규칙** (콘솔 → Firestore → 규칙):
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /submissions/{doc} {
      allow read: if true;              // 공개 읽기 (갤러리)
      allow write: if request.auth != null;  // 쓰기는 앱(인증)만
    }
  }
}
```

**Storage 규칙** (콘솔 → Storage → 규칙):
```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /submissions/{file} {
      allow read: if true;             // 공개 읽기 (이미지)
      allow write: if request.auth != null;
    }
  }
}
```

> ⚠️ **관리자 삭제/숨김 주의:** `config.js`의 `adminPassword`는 브라우저 안에서만 확인하는 **간단한 보호**라 진짜 보안이 아닙니다.
> 위 규칙은 쓰기를 인증된 사용자로 제한하므로, 실제로 삭제가 동작하려면 갤러리에도 로그인(Firebase Auth)이 필요합니다.
> 지금처럼 삭제까지 웹에서 열어두려면 `submissions`의 `allow write: if true;`로 바꾸되, 이는 **누구나 삭제 가능**해지니 학교 내부용으로만 쓰세요.

---

## 💻 2. 로컬에서 미리보기

정적 사이트라 로컬 서버로 열면 됩니다(파일 더블클릭보다 안정적):

```bash
cd artclasshub
python3 -m http.server 8000
# 브라우저에서 http://localhost:8000
```

Firebase 연결 없이 바로 보고 싶으면 `config.js`에서 `useSampleData: true`로 바꾸세요.

---

## 🚀 3. GitHub Pages 배포

### A. 저장소 만들기
1. GitHub에서 새 저장소 생성 → 이름 **`artclasshub`** (소유자: `izzy-lee`)
2. Public으로 생성

### B. 파일 올리기
```bash
cd artclasshub
git init
git add .
git commit -m "Artable 미술 갤러리"
git branch -M main
git remote add origin https://github.com/izzy-lee/artclasshub.git
git push -u origin main
```

### C. Pages 켜기
1. 저장소 → **Settings** → 왼쪽 **Pages**
2. **Source**: `Deploy from a branch`
3. **Branch**: `main` / `/ (root)` → **Save**
4. 1~2분 뒤 **https://izzy-lee.github.io/artclasshub** 에서 확인 ✅

### D. 자동 배포
GitHub Pages는 위 설정만으로 **`main`에 push할 때마다 자동 재배포**됩니다.
따로 Actions를 만들 필요는 없어요. (원하면 `.github/workflows/`로 커스텀 가능)

---

## 📊 데이터 스키마 (`submissions` 컬렉션)

iOS 공유 확장이 저장하는 형식입니다:

| 필드 | 예시 | 표시 |
|---|---|---|
| `student_nickname` | "김하늘" | 학생 이름 |
| `title` | "봄의 정원" | 작품 제목(선택) |
| `class_code` | "3학년 2반" | 학급 |
| `created_at` | Timestamp | 업로드 날짜(MM월 DD일) |
| `download_url` | https://… | 이미지 |
| `type` | "image" / "pdf" | 종류 |
| `hidden` | true/false | 관리자 숨김(웹에서 추가) |

---

## 🔐 관리자 모드
- 우측 상단 🔒 → 비밀번호 입력(기본 `artable2026`, `config.js`에서 변경)
- 작품 열기 → **숨김/삭제** 버튼 사용
- 종료하면 일반 보기로 돌아갑니다
