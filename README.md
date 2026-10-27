# calcut

## Arka plan bildirimleri (uygulama kapalıyken mesaj ve arama alarmı) — ücretsiz

Uygulama kapalıyken (ya da telefon kilitliyken) yeni mesaj ve gelen arama
için "Alarm" görünümlü, sesli ve titreşimli bildirim gelir. Firebase'in
ücretsiz (Spark) planında çalışır; kredi kartı gerekmez.

- `worker/push-worker.js`: Cloudflare'in ücretsiz Worker'ında çalışan küçük
  sunucu. Uygulama mesaj gönderince / arama başlatınca buna haber verir; Worker
  gönderenin gerçekten o kişi olduğunu Firestore'dan doğrulayıp alıcının
  cihazlarına Firebase Cloud Messaging (FCM) ile push gönderir.
- `sw.js`: Push'u alıp bildirimi gösterir. Arama çalarken 8 saniyede bir
  yeniden çalar, cevapsız kalırsa "Cevapsız" olur. Bildirime dokununca uygulama
  açılır; PIN girildikten sonra hâlâ çalan arama ekrana gelir (arama 45 sn çalar).

### Bir kerelik kurulum

1. **Web Push anahtarı** (yapıldı): `firebase-config.js` → `window.FCM_VAPID_KEY`.
2. **Servis hesabı anahtarı:** Firebase konsolu → Proje ayarları →
   *Hizmet hesapları (Service accounts)* → "Yeni özel anahtar oluştur" →
   bir `.json` dosyası iner. Bu dosya gizlidir, kimseyle paylaşma, GitHub'a koyma.
3. **Cloudflare Worker:**
   1. https://dash.cloudflare.com adresinden ücretsiz hesap aç (kart istemez).
   2. *Workers & Pages* → *Create* → *Create Worker* → ad: `calcut-push` → *Deploy*.
   3. *Edit code* → içindekini tamamen sil, `worker/push-worker.js` dosyasının
      tamamını yapıştır → *Deploy*.
   4. Worker → *Settings* → *Variables and Secrets* → *Add* → Tür: **Secret**,
      Ad: `SERVICE_ACCOUNT`, Değer: 2. adımda inen `.json` dosyasının
      tüm içeriği → *Deploy*.
   5. Worker'ın adresini kopyala (ör. `https://calcut-push.ADIN.workers.dev`) ve
      `firebase-config.js` içindeki `window.PUSH_URL` alanına yapıştır.
4. **Firestore kuralı:** Uygulama cihaz anahtarını `users/{uid}.fcmTokens`
   alanına yazar. "Missing or insufficient permissions" hatası alırsan
   kullanıcının kendi dokümanında `fcmTokens` alanını güncellemesine izin ver.
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
