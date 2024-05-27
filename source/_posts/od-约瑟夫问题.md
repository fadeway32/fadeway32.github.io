---

layout: [od-约瑟夫问题.md](od-%D4%BC%C9%AA%B7%F2%CE%CA%CC%E2.md)

title: od-约瑟夫问题

tags: 华为od

categories: Web

top: 44

path: /article/1716820667

abbrlink: 1716820667



date: 2024-05-27 22:37:46


---

# 约瑟夫问题



# C卷,100分)- 约瑟夫问题（Java & JS & Python & C）

#### 题目描述

输入一个由随机数组成的数列（数列中每个数均是大于 0 的整数，长度已知），和初始计数值 m。

从数列首位置开始计数，计数到 m 后，将数列该位置数值替换计数值 m，

并将数列该位置数值出列，然后从下一位置从新开始计数，直到数列所有数值出列为止。

如果计数到达数列尾段，则返回数列首位置继续计数。

请编程实现上述计数过程，同时输出数值出列的顺序。

比如：输入的随机数列为：3,1,2,4，初始计数值 m=7，从数列首位置开始计数（数值 3 所在位置）

第一轮计数出列数字为 2，计数值更新 m=2，出列后数列为 3,1,4，从数值 4 所在位置从新开始计数

第二轮计数出列数字为 3，计数值更新 m=3，出列后数列为 1,4，从数值 1 所在位置开始计数

第三轮计数出列数字为 1，计数值更新 m=1，出列后数列为 4，从数值 4 所在位置开始计数

最后一轮计数出列数字为 4，计数过程完成。输出数值出列顺序为：2,3,1,4。

要求实现函数：

*void array_iterate(int len, int input_array[], int m, int output_array[])*



#### 输入描述

 int len：输入数列的长度； int intput_array[]：输入的初始数列 int m：初始计数值



#### 输出描述

 int output_array[]：输出的数值出列顺序



#### 用例

| 输入 | 3,1,2,4 4 7                                                  |
| ---- | ------------------------------------------------------------ |
| 输入 | 4                                                            |
| 输入 | 7                                                            |
| 输出 | 2,3,1,4                                                      |
| 说明 | 输入第一行是初始数列intput_array第二行是初始数列的长度len第三行是初始计数值m输出数值出列顺序 |



#### 题目解析

本题就是约瑟夫环的变种题。

约瑟夫环的解题有多种方式，比较容易理解和实现的可以使用双端队列。



即intput_array当成双端队列，从队头取出元素，判断此时计数是否为m：

- 若是，则将取出的元素加入output_arr，并将取出的元素的值赋值给m，然后len--，计数重置为1
- 若不是，则将取出的元素塞回intput_array的队尾，仅计数++



但是本题JS是基于数组实现的双端队列，因此每次头部元素出队，都意味着一次O(n)复杂度的数组元素前移一位操作，这是非常影响性能的。

对于Java，Python都有内置的双端队列结构，因此可以直接复用，对于C，可以自己实现双端队列结构。



因此JS语言我们可以选择循环链表来模拟约瑟夫环。

循环链表本身就实现了环形结构，其head.prev = tail，tail.next = head。

且循环链表删除节点的复杂度是O(1)。

唯一的遗憾是，JS没有原生的循环链表结构，我们需要自己实现。但是我们只需要实现最简单的循环链表即可，即只实现循环链表的尾部新增节点操作即可。而删除操作可以在实际业务中完成。





~~~java
class Solution{
    
    
    public static void main(String[] args) {

        Scanner sc  = new Scanner(System.in);
        Integer[] input_array =
                Arrays.stream(sc.nextLine().split(",")).map(Integer::parseInt).toArray(Integer[]::new);
        int len  = Integer.parseInt(sc.nextLine());
        int m =Integer.parseInt(sc.nextLine());

        System.out.println(getResult(input_array,len,m));
        System.out.println(getResult1(input_array,len,m));
    }


    public static String getResult1(Integer[] input_arr, int len, int m) {
        LinkedList<Integer> dq = new LinkedList<>(Arrays.asList(input_arr));

        ArrayList<Integer> output_arr = new ArrayList<>();

        int i = 1;
        while (len > 0) {
            Integer out = dq.removeFirst();

            if (i == m) {
                output_arr.add(out);
                m = out;
                i = 1;
                len--;
            } else {
                dq.add(out);
                i++;
            }
        }

        StringJoiner sj = new StringJoiner(",");
        for (Integer ele : output_arr) {
            sj.add(ele + "");
        }
        return sj.toString();
    }


    public static String  getResult(Integer[] input_array,int length,int m){
        LinkedList<Integer> dq = new LinkedList<>(Arrays.asList(input_array));
        ArrayList<Integer> output_array = new ArrayList<>();
        int i = 0;
        int len = length;
        while(len > 0){
            Integer out = dq.removeFirst();
            if(m == i){
                output_array.add(out);
                m =out;
                i = 1;
                len--;
            }else{
                dq.add(out);
                i++;
            }

        }
        StringJoiner sj = new StringJoiner(",");
        for(Integer s : output_array){
            sj.add(s+"");
        }


        return sj.toString();
    }
    
    
}



~~~

