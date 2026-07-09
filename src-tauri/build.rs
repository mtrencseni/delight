fn main() {
    tauri_build::build();

    // Compile the in-process Quick Look helper on macOS and link the frameworks.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=quicklook.m");
        cc::Build::new()
            .file("quicklook.m")
            .flag("-fobjc-arc")
            .compile("dlquicklook");
        println!("cargo:rustc-link-lib=framework=Quartz");
        println!("cargo:rustc-link-lib=framework=Cocoa");
    }
}
