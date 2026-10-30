package com.gavalkadir.calcut;

import androidx.annotation.NonNull;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.json.JSONObject;

/**
 * Receives the push server's data-only pushes (worker/_worker.js,
 * apps-script/Code.gs): { kind: "message" | "call" | "call-missed" | "test" }.
 * Data-only pushes reach this service even when the app is closed.
 * While the app is open it shows its own alarm and call screen, so nothing
 * is shown here then.
 */
public class CalcutMessagingService extends FirebaseMessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> data = message.getData();
        String kind = data.get("kind");
        if ("message".equals(kind)) acknowledge(data);
        if ("call-missed".equals(kind)) {
            Notifier.showMissedCall(this);
            return;
        }
        if (MainActivity.isInForeground()) return;
        if ("call".equals(kind)) {
            Notifier.showIncomingCall(this);
        } else {
            Notifier.showMessage(this);
        }
    }

    /**
     * Tells the push server this message's push reached the phone, so the
     * sender sees two ticks before the app is opened. The push carries the
     * server's address and a signature it checks (Code.gs deliveryAck_).
     */
    private static void acknowledge(Map<String, String> data) {
        String url = data.get("a");
        if (url == null || !url.startsWith("https://script.google.com/")) return;
        HttpURLConnection conn = null;
        try {
            JSONObject body = new JSONObject();
            body.put("kind", "ack");
            body.put("u", data.get("u"));
            body.put("c", data.get("c"));
            body.put("m", data.get("m"));
            body.put("t", data.get("t"));
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "text/plain;charset=utf-8");
            try (OutputStream out = conn.getOutputStream()) {
                out.write(bytes);
            }
            conn.getResponseCode(); // Apps Script answers with a redirect; it has run by then
        } catch (Exception e) {
            // No early receipt: the app marks it delivered when opened.
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    @Override
    public void onNewToken(@NonNull String token) {
        // The app re-registers its current token with the push server every
        // time it signs in, so there's nothing to store here.
    }
}
