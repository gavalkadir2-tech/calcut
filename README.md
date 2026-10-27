# calcut

## Arka plan bildirimleri (uygulama kapalıyken mesaj ve arama alarmı)

Uygulama kapalıyken (ya da telefon kilitliyken) yeni mesaj ve gelen arama
için "Alarm" görünümlü, sesli ve titreşimli bildirim gelir:

- `functions/index.js`: Firestore'da yeni mesaj veya arama oluşunca alıcının
  cihazlarına Firebase Cloud Messaging (FCM) ile push gönderir. Arama çalarken
  push'u 8 saniyede bir tekrarlar, cevapsız kalırsa "Cevapsız" bildirimi gönderir.
- `sw.js`: Push'u alıp bildirimi gösterir. Bildirime dokununca uygulama açılır.
  PIN girildikten sonra hâlâ çalan arama ekrana gelir (arama 45 sn çalar).

### Bir kerelik kurulum (Firebase)

1. **Web Push anahtarı:** Firebase konsolu → Proje ayarları → Cloud Messaging →
   *Web Push sertifikaları* → "Generate key pair". Anahtarı
   `firebase-config.js` içindeki `window.FCM_VAPID_KEY` alanına yapıştır.
2. **Blaze planı:** Cloud Functions için proje Blaze (kullandıkça öde) planında
   olmalı. Bu kullanımda ücretsiz kota yeterlidir.
3. **Bölge:** Firebase konsolu → Firestore → veritabanı konumu `eur3` ise
   `functions/index.js` içindeki `region` değerini `europe-west1` yap
   (`nam5` ise `us-central1` kalabilir).
4. **Fonksiyonları yükle** (bilgisayarda, proje klasöründe):
   ```
   npm install -g firebase-tools
   firebase login
   cd functions && npm install && cd ..
   firebase deploy --only functions
   ```
5. **Firestore kuralı:** Uygulama cihaz anahtarını `users/{uid}.fcmTokens`
   alanına yazar. Kullanıcının kendi dokümanını güncellemesine izin veren
   kuralların bu alanı engellememeli; "Missing or insufficient permissions"
   hatası alırsan `fcmTokens` alanını izin verilen alanlara ekle.
6. Siteyi her zamanki gibi HTTPS üzerinden yayınla.

### Telefonda

- **iPhone (iOS 16.4+):** Safari'de aç → Paylaş → *Ana Ekrana Ekle*. Uygulamayı
  ana ekrandaki ikondan aç, giriş yap → Ayarlar → *Bildirimleri Etkinleştir* →
  izin ver. (iOS'ta bildirim yalnızca ana ekrandan açılan uygulamada çalışır.)
- **Android (Chrome):** Menü → *Uygulamayı yükle / Ana ekrana ekle*, sonra aynı
  ayarı aç. Ses gelmezse: telefon Ayarlar → Uygulamalar → Chrome → Bildirimler
  (ses açık olsun) ve Pil → Chrome için kısıtlama olmasın.

Her cihazda bir kez "Bildirimleri Etkinleştir" demek yeterli; hesaptan çıkınca
o cihaz bildirim listesinden silinir.
