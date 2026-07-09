// In-process Quick Look (the real Finder QLPreviewPanel), driven from Rust.
// The panel takes key focus and handles arrow navigation itself; we observe
// its current index and report it back to Rust so Delight's cursor follows.
#import <Cocoa/Cocoa.h>
#import <Quartz/Quartz.h>

// Implemented in Rust (#[no_mangle]).
extern void dl_ql_index_changed(long index);

@interface DLQLController : NSObject <QLPreviewPanelDataSource, QLPreviewPanelDelegate>
@property(nonatomic, strong) NSArray<NSURL *> *urls;
@end

@implementation DLQLController

- (NSInteger)numberOfPreviewItemsInPreviewPanel:(QLPreviewPanel *)panel {
  return (NSInteger)self.urls.count;
}

- (id<QLPreviewItem>)previewPanel:(QLPreviewPanel *)panel previewItemAtIndex:(NSInteger)index {
  if (index < 0 || index >= (NSInteger)self.urls.count) return nil;
  return self.urls[index];
}

- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary *)change
                       context:(void *)context {
  if ([keyPath isEqualToString:@"currentPreviewItemIndex"]) {
    dl_ql_index_changed((long)[(QLPreviewPanel *)object currentPreviewItemIndex]);
  }
}

// The panel navigates with left/right itself; add up/down so a file list feels
// natural. Returning YES marks the event handled.
- (BOOL)previewPanel:(QLPreviewPanel *)panel handleEvent:(NSEvent *)event {
  if (event.type == NSEventTypeKeyDown) {
    NSInteger cur = panel.currentPreviewItemIndex;
    NSInteger n = (NSInteger)self.urls.count;
    if (event.keyCode == 125 && cur + 1 < n) { // down arrow
      panel.currentPreviewItemIndex = cur + 1;
      return YES;
    }
    if (event.keyCode == 126 && cur > 0) { // up arrow
      panel.currentPreviewItemIndex = cur - 1;
      return YES;
    }
  }
  return NO;
}

@end

static DLQLController *gController = nil;
static BOOL gObserving = NO;

void dl_ql_show(const char *const *paths, int count, int index) {
  @autoreleasepool {
    NSMutableArray<NSURL *> *urls = [NSMutableArray arrayWithCapacity:count];
    for (int i = 0; i < count; i++) {
      NSString *s = [NSString stringWithUTF8String:paths[i]];
      if (s) {
        NSURL *u = [NSURL fileURLWithPath:s];
        if (u) [urls addObject:u];
      }
    }
    if (urls.count == 0) return;

    if (!gController) gController = [[DLQLController alloc] init];
    gController.urls = urls;

    QLPreviewPanel *panel = [QLPreviewPanel sharedPreviewPanel];
    panel.dataSource = gController;
    panel.delegate = gController;
    [panel reloadData];
    if (!gObserving) {
      [panel addObserver:gController
              forKeyPath:@"currentPreviewItemIndex"
                 options:0
                 context:NULL];
      gObserving = YES;
    }
    [panel makeKeyAndOrderFront:nil];

    NSInteger idx = index;
    if (idx < 0) idx = 0;
    if (idx >= (NSInteger)urls.count) idx = (NSInteger)urls.count - 1;
    panel.currentPreviewItemIndex = idx;
  }
}

void dl_ql_close(void) {
  @autoreleasepool {
    if ([QLPreviewPanel sharedPreviewPanelExists]) {
      [[QLPreviewPanel sharedPreviewPanel] orderOut:nil];
    }
  }
}
