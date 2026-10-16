#include "wheelplay_send_result.hpp"
#include <cassert>
#include <chrono>
#include <vector>
int main() {
    std::vector<int> packets{1,2,3};
    int sent = 0;
    assert(!wheelplay::sendAll(packets, [&](int n) { ++sent; return n != 2; }));
    assert(sent == 3); // A successful final packet must not hide a middle failure.
    assert(wheelplay::sendAll(packets, [](int) { return true; }));
    assert(!wheelplay::sendAll(packets, [](int) { return false; }));
    std::vector<int> empty;
    assert(!wheelplay::sendAll(empty, [](int) { return true; }));

    // Below the pacing threshold the burst path must not engage: order and count preserved.
    std::vector<int> small(wheelplay::paceThresholdPackets - 1);
    for (size_t i = 0; i < small.size(); ++i) small[i] = static_cast<int>(i);
    std::vector<int> order;
    assert(wheelplay::sendAll(small, [&](int n) { order.push_back(n); return true; }));
    assert(order == small);

    // A paced burst still reports a middle failure and sends every packet in order.
    std::vector<int> burst(2 * wheelplay::paceThresholdPackets);
    for (size_t i = 0; i < burst.size(); ++i) burst[i] = static_cast<int>(i);
    int paced = 0;
    assert(!wheelplay::sendAll(burst, [&](int) { ++paced; return paced != 7; }));
    assert(paced == static_cast<int>(burst.size()));

    // Pacing widens the elapsed time by roughly one interval per paced packet.
    order.clear();
    auto start = std::chrono::steady_clock::now();
    assert(wheelplay::sendAll(burst, [&](int n) { order.push_back(n); return true; }));
    auto elapsedUs = std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now() - start).count();
    assert(order == burst);
    // Lower bound only, halved for scheduler slack, so slow CI cannot flake.
    assert(elapsedUs >= int64_t(burst.size() / 2) * wheelplay::paceInterval.count());
}
