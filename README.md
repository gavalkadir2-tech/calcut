# calcut

## Arka plan bildirimleri (uygulama kapalıyken mesaj ve arama alarmı) — ücretsiz

Uygulama kapalıyken (ya da telefon kilitliyken) yeni mesaj ve gelen arama
için "Alarm" görünümlü, sesli ve titreşimli bildirim gelir. Firebase'in
ücretsiz (Spark) planında çalışır; kredi kartı gerekmez.

- `apps-script/Code.gs`: Google Apps Script'te (ücretsiz, `script.google.com`)
  çalışan küçük bildirim sunucusu. Uygulama mesaj gönderince / arama başlatınca
  buna haber verir; sunucu gönderenin gerçekten o kişi olduğunu Firestore'dan
  doğrulayıp alıcının cihazlarına Firebase Cloud Messaging (FCM) ile push gönderir.
- `worker/_worker.js`: Aynı sunucunun Cloudflare sürümü (yedek). Bazı Türk
  internet sağlayıcıları `*.workers.dev` ve `*.pages.dev` adreslerini engelliyor.
- `sw.js`: Push'u alıp bildirimi gösterir. Arama çalarken 8 saniyede bir
  yeniden çalar, cevapsız kalırsa "Cevapsız" olur. Bildirime dokununca uygulama
  açılır ve hâlâ çalan arama, hesap makinesi ekranının üstünde alarm olarak
  çıkar: *Durdur* ile şifre girmeden açılır (arama 45 sn çalar). Mesajlar yine
  kilitli kalır; onlar için gizli kod ve PIN gerekir.

### Bir kerelik kurulum

1. **Web Push anahtarı** (yapıldı): `firebase-config.js` → `window.FCM_VAPID_KEY`.
2. **Servis hesabı anahtarı:** Firebase konsolu → Proje ayarları →
   *Hizmet hesapları (Service accounts)* → "Yeni özel anahtar oluştur" →
   bir `.json` dosyası iner. Bu dosya gizlidir, kimseyle paylaşma, GitHub'a koyma.
3. **Google Apps Script (bildirim sunucusu):**
   1. https://script.google.com → *Yeni proje*. Proje adını `calcut-bildirim` yap.
   2. `Code.gs` içindekini tamamen sil, `apps-script/Code.gs` dosyasının tamamını
      yapıştır → *Kaydet* (💾).
   3. Soldaki ⚙️ *Proje Ayarları* → en altta *Komut dosyası özellikleri* →
      *Komut dosyası özelliği ekle* → Özellik: `SERVICE_ACCOUNT`, Değer: 2. adımda
      inen `.json` dosyasının tüm içeriği → *Komut dosyası özelliklerini kaydet*.
   4. Sağ üstte *Dağıt* → *Yeni dağıtım* → ⚙️ → *Web uygulaması* →
      Şu kullanıcı olarak yürüt: **Ben** · Erişimi olanlar: **Herkes** → *Dağıt*.
   5. *Erişimi yetkilendir* → Google hesabını seç → "Google bu uygulamayı
      doğrulamadı" çıkarsa *Gelişmiş* → *calcut-bildirim (güvenli değil) sayfasına
      git* → *İzin ver*. (Uygulama senin kendi kodun olduğu için bu uyarı normal.)
   6. Çıkan *Web uygulaması URL'sini* (`https://script.google.com/macros/s/…/exec`)
      kopyala, `firebase-config.js` içindeki `window.PUSH_URLS` listesinin başına
      ekle. Adresi tarayıcıda açınca `"method not allowed"` yazmalı.
   7. Kodu sonradan güncellersen: *Dağıt* → *Dağıtımları yönet* → ✏️ → Sürüm:
      *Yeni sürüm* → *Dağıt* (adres değişmez).
   8. Zamanlanmış mesajlar için bir kez: düzenleyicinin üstündeki işlev
      listesinden `setup`'ı seç → ▶ *Çalıştır* → izin ver.
   9. (İsteğe bağlı) GIF araması: https://console.cloud.google.com → Firebase
      projeni seç → *API'ler ve Hizmetler* → *Kitaplık* → "Tenor API" →
      *Etkinleştir*; sonra *Kimlik bilgileri* → *Kimlik bilgisi oluştur* →
      *API anahtarı* → anahtarı kopyala. Apps Script → ⚙️ *Proje Ayarları* →
      *Komut dosyası özelliği ekle* → Özellik: `TENOR_KEY`, Değer: anahtar.
      Aramalar ve seçilen GIF bu sunucudan geçer; önizleme küçük resimleri
      Tenor'dan (media.tenor.com) yüklenir.
4. **Firestore kuralı gerekmez:** Cihaz anahtarları (`users/{uid}.fcmTokens`)
   sunucu tarafından servis hesabıyla kaydedilir.
5. Siteyi her zamanki gibi HTTPS üzerinden yayınla.

### Telefonda

- **iPhone (iOS 16.4+):** Safari'de aç → Paylaş → *Ana Ekrana Ekle*. Uygulamayı
  ana ekrandaki ikondan aç, giriş yap → Ayarlar → *Bildirimleri Etkinleştir* →
  izin ver. (iOS'ta bildirim yalnızca ana ekrandan açılan uygulamada çalışır.)
- **Android (Chrome):** Menü → *Uygulamayı yükle / Ana ekrana ekle*, sonra aynı
  ayarı aç. Ses gelmezse: telefon Ayarlar → Uygulamalar → Chrome → Bildirimler
  (ses açık olsun) ve Pil → Chrome için kısıtlama olmasın.

Her cihazda bir kez "Bildirimleri Etkinleştir" demek yeterli; hesaptan çıkınca
o cihaz bildirim listesinden silinir.

## Arama aktarma sunucusu (TURN) — isteğe bağlı, ücretsiz kotalı

İki telefon birbirine doğrudan bağlanamazsa (farklı mobil şebekeler, katı NAT)
arama sesi/görüntüsü Cloudflare'in TURN sunucuları üzerinden aktarılır. Görüşme
yine uçtan uca şifrelidir; sunucu yalnızca paketleri iletir. Kurulmazsa
aramalar eskisi gibi yalnızca STUN ile çalışır.

İki sağlayıcıdan biri yeter:

- **Metered / Open Relay** (kredi kartı istemez, ayda ~20 GB ücretsiz):
  https://www.metered.ca/tools/openrelay/ → ücretsiz hesap aç → panoda uygulamanın
  adresi `xyz.metered.live` olur; *TURN Server → Credentials* bölümünden bir **API key**
  al. Özellikler: `METERED_APP` = `xyz`, `METERED_API_KEY` = API key.
- **Cloudflare Realtime** (ayda 1000 GB ücretsiz, ama kart ister): pano → **Realtime**
  (eski adı *Calls*) → **TURN Server** → **Create** → **Turn Token ID** ve **API Token**.
  Özellikler: `TURN_KEY_ID`, `TURN_KEY_TOKEN`. İkisi de kuruluysa bu kullanılır.

1. Yukarıdan birini seç ve değerleri al.
2. **Google Apps Script** (asıl bildirim sunucusu): proje → ⚙️ *Proje Ayarları* →
   *Komut dosyası özellikleri* → seçtiğin sağlayıcının iki özelliğini ekle → kaydet. `apps-script/Code.gs`'in güncel hâlini
   yapıştırıp *Dağıt → Dağıtımları yönet → ✏️ → Yeni sürüm → Dağıt*.
3. (İsteğe bağlı) Cloudflare yedeği `calcut-bildirim`: Pages projesi → *Settings*
   → *Variables and Secrets* → aynı iki değeri aynı adlarla **Secret** olarak ekle.
4. Uygulamada Ayarlar → *Test bildirimi gönder*: sonunda "Arama aktarma sunucusu
   (TURN): açık ✅" yazmalı.

## Firestore güvenlik kuralları

Kurallar `firestore.rules` dosyasında tutulur; Firebase konsolundaki kurallar
bu dosyayla aynı olmalı. Değiştirince ya Firebase konsolunda
**Firestore → Kurallar** sekmesine dosyanın içeriğini yapıştırıp **Yayınla**'ya
bas, ya da Firebase CLI ile `firebase deploy --only firestore:rules` çalıştır
(`firebase.json` bu dosyayı gösteriyor).

**Otomatik yayınlama:** GitHub'da bir kez `FIREBASE_SERVICE_ACCOUNT` sırrı
eklenirse, main'e her birleştirmede kural testleri geçince kurallar Firebase'e
kendiliğinden yüklenir (`tools/deploy-firestore-rules.js`, Tests iş akışının
`deploy-firestore-rules` işi). Kurulum:
1. Firebase konsolu → Proje ayarları → *Hizmet hesapları* → *Yeni özel anahtar
   oluştur* → inen `.json` dosyası (push sunucusu için oluşturduğun dosya da olur).
2. GitHub → depo → *Settings* → *Secrets and variables* → *Actions* →
   *New repository secret* → Ad: `FIREBASE_SERVICE_ACCOUNT`, Değer: `.json`
   dosyasının tüm içeriği → *Add secret*.
3. Hemen yayınlamak için: *Actions* → *Tests* → *Run workflow* (main).

## Testler

`tests/` klasöründeki testler `app.js`'in gerçek kodunu (büyük dosyaların
parçalanması, Android parmak izi kilidi) tarayıcı ve Firebase yerine geçen
sahte nesnelerle çalıştırır. Her PR'da GitHub Actions'ta otomatik çalışırlar;
elle çalıştırmak için Node 22 ile:

    node --test tests/*.test.js

Kural testleri (`tests/firestore-rules/`) kuralları Firebase emülatöründe
çalıştırır ve her PR'da otomatik koşar. Elle çalıştırmak için (Java gerekir):

    cd tests/firestore-rules && npm ci && npm test
