package com.serveros.phone;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

public class MainActivity extends Activity {
    private EditText address;
    private EditText login;
    private EditText password;
    private EditText device;
    private TextView message;
    private WebView web;
    private LinearLayout form;
    private ValueCallback<Uri[]> fileCallback;

    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);

        form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        form.setPadding(pad, pad, pad, pad);
        TextView title = new TextView(this);
        title.setText("Connect to your computer");
        title.setTextSize(26);
        title.setTextColor(Color.BLACK);
        form.addView(title);
        TextView help = new TextView(this);
        help.setText("Start ServerOS on the computer and leave that window open. Then open it here, and connect this phone so each one can see the other.");
        help.setTextColor(Color.DKGRAY);
        help.setPadding(0, dp(8), 0, dp(16));
        form.addView(help);
        address = field("Computer address", "http://192.168.1.35:8787", false);
        login = field("Email or username", "", false);
        password = field("Password", "", true);
        device = field("Name for this phone", "My phone", false);
        form.addView(address);
        form.addView(login);
        form.addView(password);
        form.addView(device);
        message = new TextView(this);
        message.setTextColor(Color.rgb(140, 40, 40));
        message.setPadding(0, dp(8), 0, dp(8));
        form.addView(message);
        form.addView(button("Open my computer", new View.OnClickListener() {
            public void onClick(View view) { openComputer(); }
        }));
        form.addView(button("Connect this phone", new View.OnClickListener() {
            public void onClick(View view) { connectPhone(true); }
        }));

        ScrollView scroll = new ScrollView(this);
        scroll.addView(form);
        web = new WebView(this);
        web.setVisibility(View.GONE);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        if (Build.VERSION.SDK_INT >= 21) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        web.setWebViewClient(new WebViewClient() {
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = params.createIntent();
                try {
                    startActivityForResult(intent, 41);
                } catch (Exception err) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        LinearLayout.LayoutParams grow = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f);
        android.widget.FrameLayout stage = new android.widget.FrameLayout(this);
        stage.addView(scroll);
        stage.addView(web, new android.widget.FrameLayout.LayoutParams(
            android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
            android.widget.FrameLayout.LayoutParams.MATCH_PARENT));
        root.addView(stage, grow);
        TextView credit = new TextView(this);
        credit.setText(creditLine());
        credit.setGravity(Gravity.CENTER);
        credit.setTextColor(Color.rgb(244, 241, 234));
        credit.setBackgroundColor(Color.rgb(17, 19, 24));
        credit.setPadding(dp(8), dp(6), dp(8), dp(6));
        root.addView(credit, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        setContentView(root);

        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[] { android.Manifest.permission.POST_NOTIFICATIONS }, 7);
            }
        }
        Intent start = getIntent();
        if (start != null && start.getBooleanExtra("autolink", false)) {
            address.setText(start.getStringExtra("url"));
            login.setText(start.getStringExtra("login"));
            password.setText(start.getStringExtra("password"));
            if (start.getStringExtra("device") != null) device.setText(start.getStringExtra("device"));
            connectPhone(true);
        }
    }

    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 41 && fileCallback != null) {
            Uri[] uris = null;
            if (result == RESULT_OK && data != null) uris = new Uri[] { data.getData() };
            fileCallback.onReceiveValue(uris);
            fileCallback = null;
        }
    }

    public void onBackPressed() {
        if (web.getVisibility() == View.VISIBLE && web.canGoBack()) {
            web.goBack();
            return;
        }
        if (web.getVisibility() == View.VISIBLE) {
            web.setVisibility(View.GONE);
            form.setVisibility(View.VISIBLE);
            return;
        }
        super.onBackPressed();
    }

    private void openComputer() {
        String url = cleanUrl(address.getText().toString());
        if (url.length() == 0) {
            message.setText("Enter the address shown on the computer.");
            return;
        }
        message.setText("");
        form.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(url);
    }

    private void connectPhone(boolean alsoOpen) {
        String url = cleanUrl(address.getText().toString());
        String user = login.getText().toString().trim();
        String pass = password.getText().toString();
        String name = device.getText().toString().trim();
        if (url.length() == 0 || user.length() == 0 || pass.length() == 0) {
            message.setText("Enter the computer address, your login, and your password.");
            return;
        }
        if (name.length() == 0) name = "My phone";
        Intent service = new Intent(this, LinkService.class);
        service.putExtra("url", url);
        service.putExtra("login", user);
        service.putExtra("password", pass);
        service.putExtra("device", name);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(service);
        else startService(service);
        message.setText("Connecting this phone to the computer.");
        if (alsoOpen) openComputer();
    }

    private String cleanUrl(String value) {
        String url = value == null ? "" : value.trim();
        while (url.endsWith("/")) url = url.substring(0, url.length() - 1);
        if (url.length() == 0) return "";
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "http://" + url;
        return url;
    }

    private EditText field(String hint, String value, boolean secret) {
        EditText input = new EditText(this);
        input.setHint(hint);
        input.setText(value);
        input.setSingleLine(true);
        input.setTextColor(Color.BLACK);
        input.setHintTextColor(Color.GRAY);
        if (secret) input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.bottomMargin = dp(10);
        input.setLayoutParams(params);
        return input;
    }

    private Button button(String label, View.OnClickListener click) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setOnClickListener(click);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.bottomMargin = dp(8);
        button.setLayoutParams(params);
        return button;
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density);
    }

    private String creditLine() {
        int[] codes = new int[] {
            67,111,112,121,114,105,103,104,116,44,32,68,101,118,101,108,111,112,101,114,32,64,32,82,32,82,97,106,107,117,109,97,114,32,80,97,100,109,97,110,97,98,104,97,110
        };
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < codes.length; i++) text.append((char) codes[i]);
        return text.toString();
    }
}
