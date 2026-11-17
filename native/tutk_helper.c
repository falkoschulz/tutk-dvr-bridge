#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <signal.h>
#include <poll.h>
#include "IOTCAPIs.h"
#include "AVAPIs.h"

#define IOTYPE_IPCAM_START           0x01FF /* 511 */
#define IOTYPE_IPCAM_STOP            0x02FF /* 767 */
#define IOTYPE_LISTEVENT_REQ         0x0318 /* 792 */
#define IOTYPE_LISTEVENT_RESP        0x0319 /* 793 */
#define IOTYPE_RECORD_PLAYCONTROL    0x031A /* 794 */
#define IOTYPE_RECORD_PLAYCTRL_RESP  0x031B /* 795 */
#define IOTYPE_SETSTREAMCTRL_REQ     0x0320 /* 800 */

#define PLAY_CMD_PAUSE   0
#define PLAY_CMD_STOP    1
#define PLAY_CMD_SEEK    6
#define PLAY_CMD_START   16

#define AV_ER_DATA_NOREADY        -20012
#define AV_ER_INCOMPLETE_FRAME    -20013
#define AV_ER_LOSED_THIS_FRAME    -20014
#define AV_ER_TIMEOUT             -20011

typedef struct __attribute__((packed)) {
    uint16_t year;
    uint8_t  month;
    uint8_t  day;
    uint8_t  wday;
    uint8_t  hour;
    uint8_t  minute;
    uint8_t  second;
} STimeDay;

typedef struct __attribute__((packed)) {
    uint32_t channel;
    STimeDay stStartTime;
    STimeDay stEndTime;
    uint8_t  event;
    uint8_t  status;
    uint8_t  reserved[2];
} ListEventReq;

typedef struct __attribute__((packed)) {
    STimeDay stTime;
    uint8_t  event;
    uint8_t  status;
    uint8_t  reserved[2];
    uint32_t duration;
} AnsjerEventItem;

typedef struct __attribute__((packed)) {
    uint32_t channel;
    uint32_t total;
    uint8_t  index;
    uint8_t  endflag;
    uint8_t  count;
    uint8_t  reserved;
} ListEventRespHeader;

typedef struct __attribute__((packed)) {
    uint32_t channel;
    uint32_t command;
    uint32_t param;
    STimeDay stTimeDay;
    uint8_t  reserved[4];
} PlayRecordReq;

typedef struct __attribute__((packed)) {
    uint32_t command;
    int32_t  result;
    uint8_t  reserved[4];
} PlayRecordResp;

typedef struct __attribute__((packed)) {
    uint32_t channel;
    uint8_t  reserved[4];
} AvStreamCtrlReq;

typedef struct __attribute__((packed)) {
    uint32_t channel;
    uint8_t  quality;
    uint8_t  reserved[3];
} SetStreamCtrlReq;

static volatile sig_atomic_t g_running = 1;
static void on_sig(int s) { (void)s; g_running = 0; }

static int parse_datetime(const char *s, STimeDay *t) {
    int y = 0, m = 0, d = 0, H = 0, M = 0, S = 0;
    int n = sscanf(s, "%d-%d-%dT%d:%d:%d", &y, &m, &d, &H, &M, &S);
    if (n < 3) return -1;
    memset(t, 0, sizeof(*t));
    t->year = (uint16_t)y;
    t->month = (uint8_t)m;
    t->day = (uint8_t)d;
    t->hour = (uint8_t)H;
    t->minute = (uint8_t)M;
    t->second = (uint8_t)S;
    return 0;
}

static void add_seconds(const STimeDay *in, uint32_t dur, STimeDay *out) {
    struct tm tm_val;
    memset(&tm_val, 0, sizeof(tm_val));
    tm_val.tm_year = in->year - 1900;
    tm_val.tm_mon  = in->month - 1;
    tm_val.tm_mday = in->day;
    tm_val.tm_hour = in->hour;
    tm_val.tm_min  = in->minute;
    tm_val.tm_sec  = in->second;
    tm_val.tm_isdst = -1;
    time_t ts = mktime(&tm_val) + (time_t)dur;
    struct tm res;
    localtime_r(&ts, &res);
    memset(out, 0, sizeof(*out));
    out->year   = (uint16_t)(res.tm_year + 1900);
    out->month  = (uint8_t)(res.tm_mon + 1);
    out->day    = (uint8_t)res.tm_mday;
    out->hour   = (uint8_t)res.tm_hour;
    out->minute = (uint8_t)res.tm_min;
    out->second = (uint8_t)res.tm_sec;
}

static int connect_device(const char *uid, const char *user, const char *pass, int *out_sid, int *out_av) {
    int r = IOTC_Initialize2(0);
    if (r < 0 && r != IOTC_ER_ALREADY_INITIALIZED) {
        fprintf(stderr, "IOTC_Initialize2 failed: %d\n", r);
        return -1;
    }
    avInitialize(32);

    int sid = -1;
    for (int attempt = 0; attempt < 3; attempt++) {
        sid = IOTC_Get_SessionID();
        if (sid < 0) {
            fprintf(stderr, "IOTC_Get_SessionID failed: %d\n", sid);
            return -1;
        }
        r = IOTC_Connect_ByUID_Parallel(uid, sid);
        if (r >= 0) break;
        fprintf(stderr, "IOTC_Connect_ByUID_Parallel attempt %d failed: %d\n", attempt + 1, r);
        IOTC_Session_Close(sid);
        sid = -1;
        usleep(300000);
    }
    if (sid < 0) return -1;

    unsigned int serv_type = 0;
    int av_idx = avClientStart(sid, user, pass, 10, &serv_type, 0);
    if (av_idx < 0) {
        fprintf(stderr, "avClientStart(ch0) failed: %d\n", av_idx);
        IOTC_Session_Close(sid);
        return -1;
    }
    *out_sid = sid;
    *out_av = av_idx;
    return 0;
}

static int cmd_list(const char *uid, const char *user, const char *pass, int ch, const char *start_str, const char *end_str) {
    STimeDay start, end;
    if (parse_datetime(start_str, &start) < 0) {
        fprintf(stderr, "Invalid start date: %s\n", start_str);
        return 1;
    }
    if (end_str && end_str[0] != '\0') {
        if (parse_datetime(end_str, &end) < 0) {
            fprintf(stderr, "Invalid end date: %s\n", end_str);
            return 1;
        }
    } else {
        end = start;
        end.hour = 23; end.minute = 59; end.second = 59;
    }

    int sid = -1, av_idx = -1;
    if (connect_device(uid, user, pass, &sid, &av_idx) < 0) return 2;

    ListEventReq req;
    memset(&req, 0, sizeof(req));
    req.channel = (uint32_t)ch;
    req.stStartTime = start;
    req.stEndTime = end;

    int sr = avSendIOCtrl(av_idx, IOTYPE_LISTEVENT_REQ, (const char *)&req, sizeof(req));
    if (sr < 0) {
        fprintf(stderr, "avSendIOCtrl(792) failed: %d\n", sr);
        avClientStop(av_idx);
        IOTC_Session_Close(sid);
        return 3;
    }

    printf("{\"channel\":%d,\"date\":\"%04d-%02d-%02d\",\"clips\":[",
           ch + 1, start.year, start.month, start.day);

    char buf[8192];
    int first = 1;
    while (1) {
        unsigned int io_type = 0;
        int rr = avRecvIOCtrl(av_idx, &io_type, buf, sizeof(buf), 5000);
        if (rr < (int)sizeof(ListEventRespHeader)) {
            if (!first) break;
            if (rr == AV_ER_TIMEOUT) break;
            fprintf(stderr, "avRecvIOCtrl(793) err: %d\n", rr);
            break;
        }
        if (io_type != IOTYPE_LISTEVENT_RESP) continue;

        ListEventRespHeader *hdr = (ListEventRespHeader *)buf;
        int max_items = (rr - (int)sizeof(ListEventRespHeader)) / (int)sizeof(AnsjerEventItem);
        int count = hdr->count < max_items ? hdr->count : max_items;
        AnsjerEventItem *items = (AnsjerEventItem *)(buf + sizeof(ListEventRespHeader));

        for (int i = 0; i < count; i++) {
            STimeDay et;
            add_seconds(&items[i].stTime, items[i].duration, &et);
            if (!first) putchar(',');
            first = 0;
            printf("{\"start\":\"%04d-%02d-%02dT%02d:%02d:%02d\","
                   "\"end\":\"%04d-%02d-%02dT%02d:%02d:%02d\","
                   "\"duration\":%u,\"event\":%u,\"status\":%u}",
                   items[i].stTime.year, items[i].stTime.month, items[i].stTime.day,
                   items[i].stTime.hour, items[i].stTime.minute, items[i].stTime.second,
                   et.year, et.month, et.day, et.hour, et.minute, et.second,
                   items[i].duration, items[i].event, items[i].status);
        }
        if (hdr->endflag) break;
    }
    printf("]}\n");
    fflush(stdout);

    avClientStop(av_idx);
    IOTC_Session_Close(sid);
    avDeInitialize();
    IOTC_DeInitialize();
    return 0;
}

static int cmd_stream(const char *uid, const char *user, const char *pass, int ch, const char *start_str) {
    STimeDay t;
    if (parse_datetime(start_str, &t) < 0) {
        fprintf(stderr, "Invalid start datetime: %s\n", start_str);
        return 1;
    }

    signal(SIGINT, on_sig);
    signal(SIGTERM, on_sig);
    signal(SIGPIPE, on_sig);

    int sid = -1, av_idx = -1;
    if (connect_device(uid, user, pass, &sid, &av_idx) < 0) return 2;

    PlayRecordReq req;
    memset(&req, 0, sizeof(req));
    req.channel = (uint32_t)ch;
    req.command = PLAY_CMD_START;
    req.stTimeDay = t;

    int sr = avSendIOCtrl(av_idx, IOTYPE_RECORD_PLAYCONTROL, (const char *)&req, sizeof(req));
    if (sr < 0) {
        fprintf(stderr, "avSendIOCtrl(794 START) failed: %d\n", sr);
        avClientStop(av_idx);
        IOTC_Session_Close(sid);
        return 3;
    }

    int pb_channel = -1;
    char rbuf[256];
    for (int i = 0; i < 10; i++) {
        unsigned int io_type = 0;
        int rr = avRecvIOCtrl(av_idx, &io_type, rbuf, sizeof(rbuf), 5000);
        if (rr >= (int)sizeof(PlayRecordResp) && io_type == IOTYPE_RECORD_PLAYCTRL_RESP) {
            PlayRecordResp *resp = (PlayRecordResp *)rbuf;
            pb_channel = resp->result;
            break;
        }
        if (rr < 0 && rr != AV_ER_TIMEOUT) break;
    }
    if (pb_channel <= 0) {
        fprintf(stderr, "STATUS:error Failed to get playback channel (%d)\n", pb_channel);
        fflush(stderr);
        avClientStop(av_idx);
        IOTC_Session_Close(sid);
        return 4;
    }

    unsigned int serv_type = 0;
    int pb_av = avClientStart(sid, user, pass, 10, &serv_type, (unsigned char)pb_channel);
    if (pb_av < 0) {
        fprintf(stderr, "STATUS:error avClientStart(pb_ch=%d) failed (%d)\n", pb_channel, pb_av);
        fflush(stderr);
        avClientStop(av_idx);
        IOTC_Session_Close(sid);
        return 5;
    }

    fprintf(stderr, "STATUS:playing ch=%d pb_channel=%d\n", ch + 1, pb_channel);
    fflush(stderr);

    int flags = fcntl(STDIN_FILENO, F_GETFL, 0);
    if (flags >= 0) fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK);

    const int fbuf_size = 1024 * 1024;
    unsigned char *fbuf = malloc(fbuf_size);
    char finfo[64];
    char line[256];
    int line_pos = 0;
    int got_frames = 0;
    int noready_ticks = 0;
    int retried = 0;

    while (g_running) {
        /* Poll stdin for control commands */
        struct pollfd pfd = { .fd = STDIN_FILENO, .events = POLLIN };
        if (poll(&pfd, 1, 0) > 0 && (pfd.revents & POLLIN)) {
            char c;
            while (read(STDIN_FILENO, &c, 1) == 1) {
                if (c == '\n') {
                    line[line_pos] = '\0';
                    line_pos = 0;
                    if (strncmp(line, "STOP", 4) == 0) {
                        g_running = 0;
                        break;
                    } else if (strncmp(line, "PAUSE", 5) == 0 || strncmp(line, "RESUME", 6) == 0) {
                        PlayRecordReq preq;
                        memset(&preq, 0, sizeof(preq));
                        preq.channel = (uint32_t)ch;
                        preq.command = PLAY_CMD_PAUSE;
                        avSendIOCtrl(av_idx, IOTYPE_RECORD_PLAYCONTROL, (const char *)&preq, sizeof(preq));
                        fprintf(stderr, "STATUS:%s\n", line[0] == 'P' ? "paused" : "playing");
                        fflush(stderr);
                    } else if (strncmp(line, "SEEK ", 5) == 0) {
                        STimeDay st;
                        if (parse_datetime(line + 5, &st) == 0) {
                            PlayRecordReq sreq;
                            memset(&sreq, 0, sizeof(sreq));
                            sreq.channel = (uint32_t)ch;
                            sreq.command = PLAY_CMD_SEEK;
                            sreq.stTimeDay = st;
                            avSendIOCtrl(av_idx, IOTYPE_RECORD_PLAYCONTROL, (const char *)&sreq, sizeof(sreq));
                            fprintf(stderr, "STATUS:playing\n");
                            fflush(stderr);
                        }
                    }
                } else if (line_pos < (int)sizeof(line) - 1) {
                    line[line_pos++] = c;
                }
            }
        }
        if (!g_running) break;

        int out_size = 0, exp_size = 0, out_info = 0;
        unsigned int fidx = 0;
        int fr = avRecvFrameData2(pb_av, (char *)fbuf, fbuf_size, &out_size, &exp_size,
                                  finfo, sizeof(finfo), &out_info, &fidx);
        if (fr > 0) {
            /* Strip leading zero padding before 00 00 00 01 if present */
            int off = 0;
            while (off + 4 < fr && fbuf[off] == 0 && fbuf[off+1] == 0 && fbuf[off+2] == 0 && fbuf[off+3] == 0) {
                off++;
            }
            /* Wait for first IDR keyframe (finfo[2] == 1 or HEVC VPS 0x40) before emitting */
            if (!got_frames) {
                int is_idr = ((unsigned char)finfo[2] & 1) || (off + 4 < fr && fbuf[off+4] == 0x40);
                if (!is_idr) continue;
            }
            got_frames = 1;
            noready_ticks = 0;
            if (fwrite(fbuf + off, 1, (size_t)(fr - off), stdout) != (size_t)(fr - off)) {
                break;
            }
            fflush(stdout);
        } else if (fr == AV_ER_DATA_NOREADY || fr == AV_ER_INCOMPLETE_FRAME || fr == AV_ER_LOSED_THIS_FRAME) {
            noready_ticks++;
            if (!got_frames && !retried && noready_ticks >= 260) { /* ~4s with 0 frames: retry 794 once */
                retried = 1;
                noready_ticks = 0;
                avClientStop(pb_av);
                PlayRecordReq stop_tmp;
                memset(&stop_tmp, 0, sizeof(stop_tmp));
                stop_tmp.channel = (uint32_t)ch;
                stop_tmp.command = PLAY_CMD_STOP;
                avSendIOCtrl(av_idx, IOTYPE_RECORD_PLAYCONTROL, (const char *)&stop_tmp, sizeof(stop_tmp));
                usleep(300000);
                avSendIOCtrl(av_idx, IOTYPE_RECORD_PLAYCONTROL, (const char *)&req, sizeof(req));
                int new_ch = -1;
                for (int i = 0; i < 10; i++) {
                    unsigned int io_type = 0;
                    int rr = avRecvIOCtrl(av_idx, &io_type, rbuf, sizeof(rbuf), 3000);
                    if (rr >= (int)sizeof(PlayRecordResp) && io_type == IOTYPE_RECORD_PLAYCTRL_RESP) {
                        new_ch = ((PlayRecordResp *)rbuf)->result;
                        break;
                    }
                    if (rr < 0 && rr != AV_ER_TIMEOUT) break;
                }
                if (new_ch <= 0) {
                    fprintf(stderr, "STATUS:error Retry failed to get playback channel (%d)\n", new_ch);
                    fflush(stderr);
                    break;
                }
                pb_channel = new_ch;
                pb_av = avClientStart(sid, user, pass, 10, &serv_type, (unsigned char)pb_channel);
                if (pb_av < 0) {
                    fprintf(stderr, "STATUS:error Retry avClientStart(pb_ch=%d) failed (%d)\n", pb_channel, pb_av);
                    fflush(stderr);
                    break;
                }
                fprintf(stderr, "STATUS:playing ch=%d pb_channel=%d retry=1\n", ch + 1, pb_channel);
                fflush(stderr);
                continue;
            }
            if (!got_frames && noready_ticks > 500) { /* ~7.5s after retry with 0 frames */
                fprintf(stderr, "STATUS:error Playback stream timed out with 0 frames\n");
                fflush(stderr);
                break;
            }
            usleep(15000);
        } else {
            fprintf(stderr, "avRecvFrameData2 ended: %d\n", fr);
            break;
        }
    }

    free(fbuf);

    PlayRecordReq stop_req;
    memset(&stop_req, 0, sizeof(stop_req));
    stop_req.channel = (uint32_t)ch;
    stop_req.command = PLAY_CMD_STOP;
    avSendIOCtrl(av_idx, IOTYPE_RECORD_PLAYCONTROL, (const char *)&stop_req, sizeof(stop_req));

    avClientStop(pb_av);
    avClientStop(av_idx);
    IOTC_Session_Close(sid);
    avDeInitialize();
    IOTC_DeInitialize();
    return got_frames ? 0 : 6;
}

static int cmd_live(const char *uid, const char *user, const char *pass, int ch, const char *quality) {
    signal(SIGINT, on_sig);
    signal(SIGTERM, on_sig);
    signal(SIGPIPE, on_sig);

    int sid = -1, av_idx = -1;
    if (connect_device(uid, user, pass, &sid, &av_idx) < 0) return 2;

    int live_av = av_idx;
    if (ch != 0) {
        unsigned int serv_type = 0;
        live_av = avClientStart(sid, user, pass, 10, &serv_type, (unsigned char)ch);
        if (live_av < 0) {
            fprintf(stderr, "avClientStart(live ch=%d) failed: %d\n", ch, live_av);
            avClientStop(av_idx);
            IOTC_Session_Close(sid);
            return 5;
        }
    }

    AvStreamCtrlReq req;
    memset(&req, 0, sizeof(req));
    req.channel = (uint32_t)ch;
    int sr = avSendIOCtrl(live_av, IOTYPE_IPCAM_START, (const char *)&req, sizeof(req));
    if (sr < 0) {
        fprintf(stderr, "avSendIOCtrl(511 START) failed: %d\n", sr);
        if (live_av != av_idx) avClientStop(live_av);
        avClientStop(av_idx);
        IOTC_Session_Close(sid);
        return 3;
    }

    if (quality && (strcmp(quality, "hd") == 0 || strcmp(quality, "sd") == 0)) {
        /* Wait briefly for stream start before switching quality, then wait for 801 ack */
        usleep(200000);
        SetStreamCtrlReq qreq;
        memset(&qreq, 0, sizeof(qreq));
        qreq.channel = (uint32_t)ch;
        qreq.quality = (strcmp(quality, "hd") == 0) ? 1 : 0;
        avSendIOCtrl(live_av, IOTYPE_SETSTREAMCTRL_REQ, (const char *)&qreq, sizeof(qreq));
        char qbuf[64];
        unsigned int qtype = 0;
        avRecvIOCtrl(live_av, &qtype, qbuf, sizeof(qbuf), 1000);
    }

    fprintf(stderr, "STATUS:playing ch=%d\n", ch + 1);
    fflush(stderr);

    int flags = fcntl(STDIN_FILENO, F_GETFL, 0);
    if (flags >= 0) fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK);

    const int fbuf_size = 1024 * 1024;
    unsigned char *fbuf = malloc(fbuf_size);
    char finfo[64];
    char line[64];
    int line_pos = 0;
    int got_frames = 0;

    while (g_running) {
        struct pollfd pfd = { .fd = STDIN_FILENO, .events = POLLIN };
        if (poll(&pfd, 1, 0) > 0 && (pfd.revents & POLLIN)) {
            char c;
            while (read(STDIN_FILENO, &c, 1) == 1) {
                if (c == '\n') {
                    line[line_pos] = '\0';
                    line_pos = 0;
                    if (strncmp(line, "STOP", 4) == 0) { g_running = 0; break; }
                } else if (line_pos < (int)sizeof(line) - 1) {
                    line[line_pos++] = c;
                }
            }
        }
        if (!g_running) break;

        int out_size = 0, exp_size = 0, out_info = 0;
        unsigned int fidx = 0;
        int fr = avRecvFrameData2(live_av, (char *)fbuf, fbuf_size, &out_size, &exp_size,
                                  finfo, sizeof(finfo), &out_info, &fidx);
        if (fr > 0) {
            int off = 0;
            while (off + 4 < fr && fbuf[off] == 0 && fbuf[off+1] == 0 && fbuf[off+2] == 0 && fbuf[off+3] == 0) {
                off++;
            }
            if (!got_frames) {
                int is_idr = ((unsigned char)finfo[2] & 1) || (off + 4 < fr && fbuf[off+4] == 0x40);
                if (!is_idr) continue;
            }
            got_frames = 1;
            if (fwrite(fbuf + off, 1, (size_t)(fr - off), stdout) != (size_t)(fr - off)) break;
            fflush(stdout);
        } else if (fr == AV_ER_DATA_NOREADY || fr == AV_ER_INCOMPLETE_FRAME || fr == AV_ER_LOSED_THIS_FRAME) {
            usleep(15000);
        } else {
            fprintf(stderr, "avRecvFrameData2(live) ended: %d\n", fr);
            break;
        }
    }

    free(fbuf);
    avSendIOCtrl(live_av, IOTYPE_IPCAM_STOP, (const char *)&req, sizeof(req));
    if (live_av != av_idx) avClientStop(live_av);
    avClientStop(av_idx);
    IOTC_Session_Close(sid);
    avDeInitialize();
    IOTC_DeInitialize();
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 6) {
        fprintf(stderr, "Usage:\n  %s list <uid> <user> <pass> <ch_0based> <YYYY-MM-DD>\n"
                        "  %s stream <uid> <user> <pass> <ch_0based> <YYYY-MM-DDTHH:MM:SS>\n"
                        "  %s live <uid> <user> <pass> <ch_0based>\n", argv[0], argv[0], argv[0]);
        return 1;
    }
    const char *mode = argv[1];
    const char *uid  = argv[2];
    const char *user = argv[3];
    const char *pass = argv[4];
    int ch = atoi(argv[5]);

    if (strcmp(mode, "live") == 0) return cmd_live(uid, user, pass, ch, argc >= 7 ? argv[6] : NULL);
    if (argc < 7) return 1;
    const char *ts = argv[6];

    if (strcmp(mode, "list") == 0) return cmd_list(uid, user, pass, ch, ts, argc >= 8 ? argv[7] : NULL);
    if (strcmp(mode, "stream") == 0) return cmd_stream(uid, user, pass, ch, ts);
    fprintf(stderr, "Unknown mode: %s\n", mode);
    return 1;
}
