package com.gavalkadir.calcut;

import android.content.Context;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The phone's own alarm tone for message and call alarms. A web page can't
 * play system sounds, so when "Telefonun alarm sesi" is chosen in Settings
 * the app plays it through here while open, and Notifier uses alarm-sound
 * channels for pushes that arrive while it's closed. Both use the alarm
 * audio stream, so they ring at alarm volume like the phone's alarm clock.
 */
@CapacitorPlugin(name = "AlarmSound")
public class AlarmSoundPlugin extends Plugin {

    static final String PREFS = "calcut_sounds";
    /** "alarm" (phone's alarm tone), "silent" (vibrate only) or "default". */
    static String soundFor(Context ctx, String kind) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(kind, "default");
    }

    static Uri alarmUri() {
        Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        return uri;
    }

    static AudioAttributes alarmAttributes() {
        return new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
    }

    private Ringtone playing;
    private final Handler handler = new Handler(Looper.getMainLooper());

    @PluginMethod
    public void setPreference(PluginCall call) {
        String kind = call.getString("kind", "");
        String sound = call.getString("sound", "default");
        if (!"message".equals(kind) && !"call".equals(kind)) {
            call.reject("invalid kind");
            return;
        }
        SharedPreferences.Editor e = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        e.putString(kind, sound).apply();
        call.resolve();
    }

    /** Plays the alarm tone: looping until stop() for calls, a few seconds otherwise. */
    @PluginMethod
    public void play(PluginCall call) {
        boolean loop = call.getBoolean("loop", false);
        int maxMs = call.getInt("maxMs", 4000);
        handler.post(() -> {
            stopNow();
            Uri uri = alarmUri();
            if (uri == null) return;
            Ringtone r = RingtoneManager.getRingtone(getContext(), uri);
            if (r == null) return;
            r.setAudioAttributes(alarmAttributes());
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) r.setLooping(loop);
            r.play();
            playing = r;
            if (!loop) handler.postDelayed(this::stopNow, maxMs);
        });
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        handler.post(this::stopNow);
        call.resolve();
    }

    private void stopNow() {
        handler.removeCallbacksAndMessages(null);
        if (playing != null) {
            playing.stop();
            playing = null;
        }
    }
}
